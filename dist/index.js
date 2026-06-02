import { spawnSync } from "node:child_process";
import https from "node:https";
const defineExtension = ((extension) => extension);
// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
const EXIT_CODE = {
    GENERIC_FAILURE: 1,
    USAGE: 2,
    NOT_FOUND: 3,
};
class CommandError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
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
// --status-map parser: "Linear State=pm_status,Other State=pm_status"
// Keys are matched case-insensitively against the Linear state name and take
// precedence over the built-in mapStatus heuristic. Returns a lower-cased map.
// Pure + exported for unit testing.
// ---------------------------------------------------------------------------
export function parseStatusMap(raw) {
    const map = {};
    if (!raw)
        return map;
    for (const pair of raw.split(",")) {
        const idx = pair.indexOf("=");
        if (idx === -1)
            continue;
        const key = pair.slice(0, idx).trim().toLowerCase();
        const value = pair.slice(idx + 1).trim();
        if (key && value)
            map[key] = value;
    }
    return map;
}
// Resolve a pm status for an issue, preferring an explicit --status-map entry
// (matched on the Linear state name) over the built-in heuristic. Pure.
export function resolveStatus(stateType, stateName, statusMap) {
    const override = statusMap[stateName.trim().toLowerCase()];
    if (override)
        return override;
    return mapStatus(stateType, stateName);
}
// ---------------------------------------------------------------------------
// Provenance marker. We can't write registerItemFields custom fields via
// `pm create` from a standalone extension, so encode linear_id + linear_url in
// the item description behind a stable, machine-parseable marker. Pure.
// ---------------------------------------------------------------------------
const PROVENANCE_MARKER = "[linear]";
export function buildProvenance(issue) {
    const url = issue.url ?? `https://linear.app/issue/${issue.identifier}`;
    return `${PROVENANCE_MARKER} linear_id=${issue.id} linear_url=${url}`;
}
// Extract { linear_id, linear_url } from a pm item's description, if present.
// Returns undefined when the item has no Linear provenance. Pure + exported.
export function parseProvenance(description) {
    if (!description || !description.includes(PROVENANCE_MARKER))
        return undefined;
    const idMatch = description.match(/linear_id=(\S+)/);
    const urlMatch = description.match(/linear_url=(\S+)/);
    if (!idMatch)
        return undefined;
    return {
        linear_id: idMatch[1],
        linear_url: urlMatch ? urlMatch[1] : "",
    };
}
// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------
// Build the issues query. When `project` is supplied we add a project-name
// filter clause; otherwise we omit it entirely (a `null`/empty project filter
// would match nothing rather than "any project").
function buildIssuesQuery(hasProject) {
    const projectFilter = hasProject ? "\n      project: { name: { eq: $project } }" : "";
    const projectVar = hasProject ? ", $project: String!" : "";
    return `
query($team: String!, $first: Int!, $after: String${projectVar}) {
  issues(
    first: $first
    after: $after
    filter: {
      team: { key: { eq: $team } }${projectFilter}
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
      url
    }
    pageInfo { hasNextPage endCursor }
  }
}
`.trim();
}
// ---------------------------------------------------------------------------
// Fetch all issues for a team, following GraphQL cursor pagination up to limit.
// ---------------------------------------------------------------------------
async function fetchAllLinearIssues(apiKey, team, limit, project) {
    const all = [];
    let after = null;
    const hasProject = typeof project === "string" && project.trim().length > 0;
    const query = buildIssuesQuery(hasProject);
    while (all.length < limit) {
        const remaining = limit - all.length;
        const first = Math.min(remaining, LINEAR_MAX_PAGE_SIZE);
        const variables = {
            team: team.toUpperCase(),
            first,
            after,
        };
        if (hasProject)
            variables.project = project.trim();
        const response = await linearRequest(apiKey, query, variables);
        if (response.errors?.length) {
            const msgs = response.errors.map((e) => e.message).join("; ");
            throw new CommandError(`Linear API error: ${msgs}`);
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
        throw new CommandError("LINEAR_API_KEY environment variable is not set. " +
            "Get your API key at https://linear.app/settings/api", EXIT_CODE.USAGE);
    }
    const scope = options.project ? ` project "${options.project}"` : "";
    console.error(`Fetching issues from Linear team: ${options.team}${scope} (limit: ${options.limit})`);
    const issues = await fetchAllLinearIssues(apiKey, options.team, options.limit, options.project);
    if (issues.length === 0) {
        console.error(`No issues found for team "${options.team}"${scope}. Check the team slug, project name, and your API key permissions.`);
        return { synced: 0, skipped: 0, team: options.team, issues: [] };
    }
    const statusMap = options.statusMap ?? {};
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
        const status = resolveStatus(issue.state.type, issue.state.name, statusMap);
        const priority = mapPriority(issue.priority);
        const tags = issue.labels.nodes.map((l) => l.name);
        const body = issue.description ?? "";
        const title = `[${issue.identifier}] ${issue.title}`;
        // `pm create` has no generic setter for the registerItemFields custom
        // fields from a standalone extension, so we persist Linear provenance in
        // the description behind a stable marker. This survives round-trips and is
        // what `pm linear export` reads back to skip re-creating known issues.
        const description = buildProvenance(issue);
        if (!options.dryRun) {
            const spawnArgs = [
                "--path", pm_root,
                "create",
                "--title", title,
                "--status", status,
                "--priority", String(priority),
                "--description", description,
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
function readPmItems(pmRoot) {
    const result = spawnSync("pm", ["--path", pmRoot, "--json", "list", "--full", "--include-body", "--limit", "10000"], { encoding: "utf-8" });
    if (result.status !== 0) {
        throw new CommandError(result.stderr || "pm list failed");
    }
    try {
        const parsed = JSON.parse(result.stdout);
        const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
        return items;
    }
    catch {
        throw new CommandError("Could not parse `pm list --json` output.");
    }
}
// Pure transform: pm item -> Linear issue-create payload. Items that already
// carry Linear provenance are flagged so `--push` can skip re-creating them.
export function itemToLinearPayload(item) {
    const provenance = parseProvenance(item.description);
    return {
        title: item.title ?? "(untitled)",
        description: item.body || item.description || "",
        pmId: item.id,
        alreadyInLinear: provenance !== undefined,
        linearUrl: provenance?.linear_url || undefined,
    };
}
// Resolve a Linear team key (e.g. "ENG") to its internal id for issueCreate.
const TEAM_QUERY = `
query($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) { nodes { id } }
}
`.trim();
const ISSUE_CREATE_MUTATION = `
mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}
`.trim();
async function resolveTeamId(apiKey, teamKey) {
    const resp = await linearRequest(apiKey, TEAM_QUERY, { key: teamKey.toUpperCase() });
    if (resp.errors?.length) {
        throw new CommandError(`Linear API error resolving team ${teamKey}: ${resp.errors.map((e) => e.message).join("; ")}`);
    }
    const id = resp.data?.teams?.nodes?.[0]?.id;
    if (!id) {
        throw new CommandError(`Linear team "${teamKey}" not found.`, EXIT_CODE.NOT_FOUND);
    }
    return id;
}
// ---------------------------------------------------------------------------
// Extension definition
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-linear",
    version: "2026.6.2",
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
                { long: "--project", value_name: "name", description: "Filter by Linear project name. Optional." },
                { long: "--state", value_name: "name", description: "Filter by Linear state name (e.g. 'In Progress', 'Todo'). Optional." },
                { long: "--status-map", value_name: "map", description: "Override status mapping, e.g. \"In Review=in_progress,Backlog=open\". Optional." },
                { long: "--limit", value_name: "n", description: "Maximum number of issues to fetch (default: 100)" },
                { long: "--dry-run", description: "Preview what would be synced without writing anything" },
            ],
            async run(ctx) {
                const team = readStringOption(ctx.options, "team");
                const project = readStringOption(ctx.options, "project");
                const stateFilter = readStringOption(ctx.options, "state");
                const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
                const limit = readNumberOption(ctx.options, "limit") ?? 100;
                const dryRun = readBooleanOption(ctx.options, "dry-run");
                if (!team) {
                    throw new CommandError("--team is required. Example: pm linear sync --team ENG", EXIT_CODE.USAGE);
                }
                if (dryRun) {
                    console.error("Running in dry-run mode — no items will be written.");
                }
                try {
                    const result = await syncLinearIssues({ team, project, stateFilter, statusMap, limit, dryRun }, ctx.pm_root);
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
                    // Preserve a more specific exitCode (e.g. a missing API key is a
                    // USAGE error) rather than flattening everything to a generic failure.
                    if (err instanceof CommandError)
                        throw err;
                    const message = err instanceof Error ? err.message : String(err);
                    throw new CommandError(`Linear sync failed: ${message}`);
                }
            },
        });
        // -----------------------------------------------------------------------
        // schema — declare Linear provenance fields so the workspace knows them
        // -----------------------------------------------------------------------
        api.registerItemFields([
            { name: "linear_id", type: "string", optional: true },
            { name: "linear_url", type: "string", optional: true },
        ]);
        // -----------------------------------------------------------------------
        // importer — `pm linear import` (native import pipeline; pulls issues via
        // the Linear GraphQL API and creates pm items, reusing the sync core).
        // -----------------------------------------------------------------------
        api.registerImporter("linear", async (ctx) => {
            const team = readStringOption(ctx.options, "team") ?? process.env["LINEAR_DEFAULT_TEAM"];
            if (!team) {
                throw new CommandError("pm linear import requires --team <slug> (or set LINEAR_DEFAULT_TEAM). " +
                    "Example: pm linear import --team ENG", EXIT_CODE.USAGE);
            }
            const project = readStringOption(ctx.options, "project");
            const stateFilter = readStringOption(ctx.options, "state");
            const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
            const limit = readNumberOption(ctx.options, "limit") ?? 100;
            const dryRun = readBooleanOption(ctx.options, "dry-run");
            try {
                const result = await syncLinearIssues({ team, project, stateFilter, statusMap, limit, dryRun }, ctx.pm_root);
                console.error(`Imported ${result.synced} issue(s) from Linear team ${result.team.toUpperCase()}` +
                    (result.skipped > 0 ? ` (${result.skipped} skipped)` : ""));
                return {
                    imported: result.synced,
                    skipped: result.skipped,
                    team: result.team.toUpperCase(),
                    dryRun,
                };
            }
            catch (err) {
                if (err instanceof CommandError)
                    throw err;
                const message = err instanceof Error ? err.message : String(err);
                throw new CommandError(`Linear import failed: ${message}`);
            }
        });
        // -----------------------------------------------------------------------
        // exporter — `pm linear export` (render pm items as Linear issue-create
        // payloads). Prints the payload JSON by default; only mutates Linear when
        // BOTH --push is set AND LINEAR_API_KEY is present (requires --team).
        // -----------------------------------------------------------------------
        api.registerExporter("linear", async (ctx) => {
            const push = readBooleanOption(ctx.options, "push");
            const items = readPmItems(ctx.pm_root);
            const payloads = items.map(itemToLinearPayload);
            if (!push) {
                // Strip internal flags from the printed payload.
                const printable = payloads.map((p) => ({
                    title: p.title,
                    description: p.description,
                    alreadyInLinear: p.alreadyInLinear,
                    ...(p.linearUrl ? { linearUrl: p.linearUrl } : {}),
                }));
                console.log(JSON.stringify(printable, null, 2));
                return { exported: printable.length, pushed: false };
            }
            const apiKey = process.env["LINEAR_API_KEY"];
            if (!apiKey) {
                throw new CommandError("--push requires LINEAR_API_KEY. Get a key at https://linear.app/settings/api", EXIT_CODE.USAGE);
            }
            const team = readStringOption(ctx.options, "team") ?? process.env["LINEAR_DEFAULT_TEAM"];
            if (!team) {
                throw new CommandError("--push requires --team <slug> to create issues in Linear.", EXIT_CODE.USAGE);
            }
            const teamId = await resolveTeamId(apiKey, team);
            let created = 0;
            let skipped = 0;
            for (const payload of payloads) {
                // Don't re-create items that already originated in Linear.
                if (payload.alreadyInLinear) {
                    skipped++;
                    continue;
                }
                const resp = await linearRequest(apiKey, ISSUE_CREATE_MUTATION, {
                    input: { teamId, title: payload.title, description: payload.description },
                });
                if (resp.errors?.length) {
                    throw new CommandError(`Linear issueCreate failed: ${resp.errors.map((e) => e.message).join("; ")}`);
                }
                created++;
            }
            console.error(`Pushed ${created} issue(s) to Linear team ${team.toUpperCase()}` +
                (skipped > 0 ? ` (${skipped} already linked, skipped)` : ""));
            return { exported: payloads.length, pushed: true, created, skipped };
        });
        // -----------------------------------------------------------------------
        // Importer: linear-sync
        // -----------------------------------------------------------------------
        api.registerImporter("linear-sync", async (ctx) => {
            const team = readStringOption(ctx.options, "team") ??
                process.env["LINEAR_DEFAULT_TEAM"];
            if (!team) {
                throw new CommandError("linear-sync importer requires a 'team' option or LINEAR_DEFAULT_TEAM env var", EXIT_CODE.USAGE);
            }
            const limit = readNumberOption(ctx.options, "limit") ?? 100;
            const stateFilter = readStringOption(ctx.options, "state");
            const project = readStringOption(ctx.options, "project");
            const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
            const result = await syncLinearIssues({ team, project, stateFilter, statusMap, limit }, ctx.pm_root);
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