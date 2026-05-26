import { spawnSync } from "node:child_process";
import https from "node:https";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LinearLabel {
  name: string;
}

interface LinearState {
  name: string;
  type: string;
}

interface LinearCycle {
  name: string;
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: LinearState;
  labels: { nodes: LinearLabel[] };
  dueDate: string | null;
  cycle: LinearCycle | null;
}

interface LinearResponse {
  data?: {
    issues?: {
      nodes: LinearIssue[];
    };
  };
  errors?: Array<{ message: string }>;
}

// ---------------------------------------------------------------------------
// Linear priority → pm priority
// Linear: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
// pm:     1=Urgent,      2=High,   3=Medium, 4=Low
// ---------------------------------------------------------------------------
function mapPriority(linearPriority: number): number {
  switch (linearPriority) {
    case 1:
      return 1; // Urgent → Urgent
    case 2:
      return 2; // High → High
    case 3:
      return 3; // Medium → Medium
    case 4:
      return 4; // Low → Low
    default:
      return 3; // No priority (0) → Medium
  }
}

// ---------------------------------------------------------------------------
// Linear state type → pm status
// ---------------------------------------------------------------------------
function mapStatus(
  stateType: string,
  stateName: string
): "open" | "in_progress" | "closed" | "blocked" {
  const type = stateType.toLowerCase();
  const name = stateName.toLowerCase();

  if (type === "completed" || type === "cancelled") return "closed";
  if (type === "started") return "in_progress";

  // Fallback: match on state name
  if (name.includes("in progress") || name.includes("in review"))
    return "in_progress";
  if (name.includes("blocked")) return "blocked";
  if (name.includes("done") || name.includes("completed")) return "closed";
  if (name.includes("cancelled")) return "closed";

  return "open"; // triage / backlog / unstarted
}

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------
const ISSUES_QUERY = `
query($team: String!, $limit: Int!) {
  issues(
    first: $limit
    filter: {
      team: { key: { eq: $team } }
    }
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name type }
      labels { nodes { name } }
      dueDate
      cycle { name }
    }
  }
}
`.trim();

// ---------------------------------------------------------------------------
// Linear GraphQL client (native Node.js https — no external deps)
// ---------------------------------------------------------------------------
function linearRequest(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<LinearResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });

    const req = https.request(
      {
        hostname: "api.linear.app",
        path: "/graphql",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: apiKey,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            resolve(JSON.parse(raw) as LinearResponse);
          } catch (err) {
            reject(new Error(`Failed to parse Linear response: ${String(err)}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Core sync logic — shared between command and importer
// ---------------------------------------------------------------------------
interface SyncOptions {
  team: string;
  stateFilter?: string;
  limit: number;
  dryRun?: boolean;
}

interface SyncResult {
  synced: number;
  skipped: number;
  team: string;
  issues: LinearIssue[];
}

async function syncLinearIssues(
  options: SyncOptions,
  pm_root: string
): Promise<SyncResult> {
  const apiKey = process.env["LINEAR_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY environment variable is not set. " +
        "Get your API key at https://linear.app/settings/api"
    );
  }

  console.error(`Fetching issues from Linear team: ${options.team} (limit: ${options.limit})`);

  const response = await linearRequest(apiKey, ISSUES_QUERY, {
    team: options.team.toUpperCase(),
    limit: options.limit,
  });

  if (response.errors?.length) {
    const msgs = response.errors.map((e) => e.message).join("; ");
    throw new Error(`Linear API error: ${msgs}`);
  }

  const issues = response.data?.issues?.nodes ?? [];

  if (issues.length === 0) {
    console.error(`No issues found for team "${options.team}". Check the team slug and your API key permissions.`);
    return { synced: 0, skipped: 0, team: options.team, issues: [] };
  }

  let synced = 0;
  let skipped = 0;

  for (const issue of issues) {
    // Optional state name filter
    if (options.stateFilter) {
      const stateName = issue.state.name.toLowerCase();
      if (!stateName.includes(options.stateFilter.toLowerCase())) {
        skipped++;
        continue;
      }
    }

    const status = mapStatus(issue.state.type, issue.state.name);
    const priority = mapPriority(issue.priority);
    const tags = issue.labels.nodes.map((l) => l.name);
    const body = issue.description ?? "";
    const title = `[${issue.identifier}] ${issue.title}`;

    if (!options.dryRun) {
      const spawnArgs = [
        "--path", pm_root,
        "create",
        "--title", title,
        "--status", status,
        "--priority", String(priority),
      ];
      if (body) spawnArgs.push("--body", body);
      if (tags.length > 0) spawnArgs.push("--tags", tags.join(","));
      if (issue.dueDate) spawnArgs.push("--due-date", issue.dueDate);

      const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
      if (result.status !== 0) {
        console.error(`Failed to create item for ${issue.identifier}: ${result.stderr}`);
      }
    } else {
      console.error(
        `[dry-run] Would upsert: ${issue.identifier} — ${issue.title} (${status}, p${priority})`
      );
    }
    synced++;
  }

  return { synced, skipped, team: options.team, issues };
}

// ---------------------------------------------------------------------------
// Extension definition
// ---------------------------------------------------------------------------
export default defineExtension({
  name: "pm-linear",
  version: "2026.5.26",

  activate(api) {
    // -----------------------------------------------------------------------
    // Command: pm linear sync
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "linear sync",
      description: "Sync Linear.app issues into pm items",
      intent: "Fetch issues from a Linear team and upsert them as pm items",
      examples: [
        "pm linear sync --team ENG",
        "pm linear sync --team ENG --state 'In Progress'",
        "pm linear sync --team ENG --limit 50",
        "pm linear sync --team ENG --dry-run",
      ],
      flags: [
        { long: "--team", value_name: "slug", description: "Linear team slug (e.g. ENG, BACKEND). Required." },
        { long: "--state", value_name: "name", description: "Filter by Linear state name (e.g. 'In Progress', 'Todo'). Optional." },
        { long: "--limit", value_name: "n", description: "Maximum number of issues to fetch (default: 100)" },
        { long: "--dry-run", description: "Preview what would be synced without writing anything" },
      ],

      async run(ctx) {
        const team = ctx.options["team"] as string;
        const stateFilter = ctx.options["state"] as string | undefined;
        const limit = (ctx.options["limit"] as number | undefined) ?? 100;
        const dryRun = (ctx.options["dry-run"] as boolean | undefined) ?? false;

        if (!team) {
          console.error("--team is required. Example: pm linear sync --team ENG");
          return { success: false, error: "Missing --team flag" };
        }

        if (dryRun) {
          console.error("Running in dry-run mode — no items will be written.");
        }

        try {
          const result = await syncLinearIssues(
            { team, stateFilter, limit, dryRun },
            ctx.pm_root
          );

          const verb = dryRun ? "Would sync" : "Synced";
          const summary = `${verb} ${result.synced} issue${result.synced !== 1 ? "s" : ""} from Linear team ${result.team.toUpperCase()}`;
          if (result.skipped > 0) {
            console.error(
              `${summary} (${result.skipped} skipped by state filter)`
            );
          } else {
            console.error(summary);
          }

          return {
            success: true,
            synced: result.synced,
            skipped: result.skipped,
            team: result.team.toUpperCase(),
            dryRun,
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Linear sync failed: ${message}`);
          return { success: false, error: message };
        }
      },
    });

    // -----------------------------------------------------------------------
    // Importer: linear-sync
    // -----------------------------------------------------------------------
    api.registerImporter("linear-sync", async (ctx) => {
      const team =
        (ctx.options["team"] as string | undefined) ??
        process.env["LINEAR_DEFAULT_TEAM"];

      if (!team) {
        throw new Error(
          "linear-sync importer requires a 'team' option or LINEAR_DEFAULT_TEAM env var"
        );
      }

      const limit = (ctx.options["limit"] as number | undefined) ?? 100;
      const stateFilter = ctx.options["state"] as string | undefined;

      const result = await syncLinearIssues(
        { team, stateFilter, limit },
        ctx.pm_root
      );

      console.error(
        `Synced ${result.synced} issues from Linear team ${result.team.toUpperCase()}`
      );

      return {
        synced: result.synced,
        skipped: result.skipped,
        team: result.team.toUpperCase(),
      };
    });
  },
});
