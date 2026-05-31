import { spawnSync } from "node:child_process";
import https from "node:https";
const defineExtension = ((extension) => extension);
// Linear's GraphQL API caps `first` at 250 per page; request at most that and
// follow pageInfo.endCursor for the rest.
const LINEAR_MAX_PAGE_SIZE = 250;
// ---------------------------------------------------------------------------
// Option readers — tolerate both kebab-case and camelCase keys.
// The pm CLI normalizes loose extension flags to camelCase (e.g. --dry-run
// arrives as `dryRun`). Reading only the kebab key silently yields undefined,
// which for --dry-run means a "preview" that actually writes. Check both.
// ---------------------------------------------------------------------------
function camelKey(kebab) {
    return kebab.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
}
function readStringOption(options, kebab) {
    const v = options[kebab] ?? options[camelKey(kebab)];
    return typeof v === "string" ? v : v === undefined ? undefined : String(v);
}
function readNumberOption(options, kebab) {
    const v = options[kebab] ?? options[camelKey(kebab)];
    if (v === undefined || v === null)
        return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
}
function readBooleanOption(options, kebab) {
    const v = options[kebab] ?? options[camelKey(kebab)];
    if (typeof v === "boolean")
        return v;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        return s === "true" || s === "1" || s === "yes" || s === "";
    }
    return Boolean(v);
}
// ---------------------------------------------------------------------------
// Linear priority → pm priority
// Linear: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
// pm:     1=Urgent,      2=High,   3=Medium, 4=Low
// ---------------------------------------------------------------------------
function mapPriority(linearPriority) {
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
function mapStatus(stateType, stateName) {
    const type = stateType.toLowerCase();
    const name = stateName.toLowerCase();
    if (type === "completed" || type === "cancelled")
        return "closed";
    if (type === "started")
        return "in_progress";
    // Fallback: match on state name
    if (name.includes("in progress") || name.includes("in review"))
        return "in_progress";
    if (name.includes("blocked"))
        return "blocked";
    if (name.includes("done") || name.includes("completed"))
        return "closed";
    if (name.includes("cancelled"))
        return "closed";
    return "open"; // triage / backlog / unstarted
}
// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------
const ISSUES_QUERY = `
query($team: String!, $first: Int!, $after: String) {
  issues(
    first: $first
    after: $after
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
    pageInfo { hasNextPage endCursor }
  }
}
`.trim();
// ---------------------------------------------------------------------------
// Fetch all issues for a team, following GraphQL cursor pagination up to limit.
// ---------------------------------------------------------------------------
async function fetchAllLinearIssues(apiKey, team, limit) {
    const all = [];
    let after = null;
    while (all.length < limit) {
        const remaining = limit - all.length;
        const first = Math.min(remaining, LINEAR_MAX_PAGE_SIZE);
        const response = await linearRequest(apiKey, ISSUES_QUERY, {
            team: team.toUpperCase(),
            first,
            after,
        });
        if (response.errors?.length) {
            const msgs = response.errors.map((e) => e.message).join("; ");
            throw new Error(`Linear API error: ${msgs}`);
        }
        const page = response.data?.issues;
        const nodes = page?.nodes ?? [];
        all.push(...nodes);
        const info = page?.pageInfo;
        if (!info?.hasNextPage || !info.endCursor || nodes.length === 0)
            break;
        after = info.endCursor;
    }
    return all.slice(0, limit);
}
// ---------------------------------------------------------------------------
// Linear GraphQL client (native Node.js https — no external deps)
// ---------------------------------------------------------------------------
function linearRequest(apiKey, query, variables) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const req = https.request({
            hostname: "api.linear.app",
            path: "/graphql",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                Authorization: apiKey,
            },
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                try {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    resolve(JSON.parse(raw));
                }
                catch (err) {
                    reject(new Error(`Failed to parse Linear response: ${String(err)}`));
                }
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}
async function syncLinearIssues(options, pm_root) {
    const apiKey = process.env["LINEAR_API_KEY"];
    if (!apiKey) {
        throw new Error("LINEAR_API_KEY environment variable is not set. " +
            "Get your API key at https://linear.app/settings/api");
    }
    console.error(`Fetching issues from Linear team: ${options.team} (limit: ${options.limit})`);
    const issues = await fetchAllLinearIssues(apiKey, options.team, options.limit);
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
            if (body)
                spawnArgs.push("--body", body);
            if (tags.length > 0)
                spawnArgs.push("--tags", tags.join(","));
            if (issue.dueDate)
                spawnArgs.push("--deadline", issue.dueDate);
            const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
            if (result.status !== 0) {
                console.error(`Failed to create item for ${issue.identifier}: ${result.stderr}`);
                skipped++;
                continue;
            }
        }
        else {
            console.error(`[dry-run] Would upsert: ${issue.identifier} — ${issue.title} (${status}, p${priority})`);
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
    version: "2026.5.31",
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
                const team = readStringOption(ctx.options, "team");
                const stateFilter = readStringOption(ctx.options, "state");
                const limit = readNumberOption(ctx.options, "limit") ?? 100;
                const dryRun = readBooleanOption(ctx.options, "dry-run");
                if (!team) {
                    throw new Error("--team is required. Example: pm linear sync --team ENG");
                }
                if (dryRun) {
                    console.error("Running in dry-run mode — no items will be written.");
                }
                try {
                    const result = await syncLinearIssues({ team, stateFilter, limit, dryRun }, ctx.pm_root);
                    const verb = dryRun ? "Would sync" : "Synced";
                    const summary = `${verb} ${result.synced} issue${result.synced !== 1 ? "s" : ""} from Linear team ${result.team.toUpperCase()}`;
                    if (result.skipped > 0) {
                        console.error(`${summary} (${result.skipped} skipped by state filter)`);
                    }
                    else {
                        console.error(summary);
                    }
                    return {
                        success: true,
                        synced: result.synced,
                        skipped: result.skipped,
                        team: result.team.toUpperCase(),
                        dryRun,
                    };
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    throw new Error(`Linear sync failed: ${message}`);
                }
            },
        });
        // -----------------------------------------------------------------------
        // Importer: linear-sync
        // -----------------------------------------------------------------------
        api.registerImporter("linear-sync", async (ctx) => {
            const team = readStringOption(ctx.options, "team") ??
                process.env["LINEAR_DEFAULT_TEAM"];
            if (!team) {
                throw new Error("linear-sync importer requires a 'team' option or LINEAR_DEFAULT_TEAM env var");
            }
            const limit = readNumberOption(ctx.options, "limit") ?? 100;
            const stateFilter = readStringOption(ctx.options, "state");
            const result = await syncLinearIssues({ team, stateFilter, limit }, ctx.pm_root);
            console.error(`Synced ${result.synced} issues from Linear team ${result.team.toUpperCase()}`);
            return {
                synced: result.synced,
                skipped: result.skipped,
                team: result.team.toUpperCase(),
            };
        });
    },
});
//# sourceMappingURL=index.js.map