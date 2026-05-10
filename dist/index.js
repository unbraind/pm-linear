function defineExtension(m){return m}
import https from "node:https";
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
        return "done";
    if (type === "started")
        return "wip";
    // Fallback: match on state name
    if (name.includes("in progress") || name.includes("in review"))
        return "wip";
    if (name.includes("blocked"))
        return "blocked";
    if (name.includes("done") || name.includes("completed"))
        return "done";
    if (name.includes("cancelled"))
        return "done";
    return "todo"; // triage / backlog / unstarted
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
async function syncLinearIssues(options, pm, log) {
    const apiKey = process.env["LINEAR_API_KEY"];
    if (!apiKey) {
        throw new Error("LINEAR_API_KEY environment variable is not set. " +
            "Get your API key at https://linear.app/settings/api");
    }
    log.info(`Fetching issues from Linear team: ${options.team} (limit: ${options.limit})`);
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
        log.warn(`No issues found for team "${options.team}". Check the team slug and your API key permissions.`);
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
        const meta = {
            linear_id: issue.id,
            linear_team: options.team.toUpperCase(),
            linear_state: issue.state.name,
            linear_identifier: issue.identifier,
        };
        if (issue.dueDate)
            meta["due_date"] = issue.dueDate;
        if (issue.cycle?.name)
            meta["linear_cycle"] = issue.cycle.name;
        const body = issue.description ?? "";
        if (!options.dryRun) {
            await pm.upsertItem({
                idSuffix: issue.identifier,
                title: `[${issue.identifier}] ${issue.title}`,
                body,
                status,
                priority,
                tags,
                meta,
            });
        }
        else {
            log.info(`[dry-run] Would upsert: ${issue.identifier} — ${issue.title} (${status}, p${priority})`);
        }
        synced++;
    }
    return { synced, skipped, team: options.team, issues };
}
// ---------------------------------------------------------------------------
// Extension definition
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-ext-linear",
    version: "0.1.0",
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
                {
                    long: "--team",
                    value_name: "slug",
                    description: "Linear team slug (e.g. ENG, BACKEND). Required.",
                },
                {
                    long: "--state",
                    value_name: "name",
                    description: "Filter by Linear state name (e.g. 'In Progress', 'Todo'). Optional.",
                },
                {
                    long: "--limit",
                    value_name: "n",
                    description: "Maximum number of issues to fetch (default: 100)",
                },
                {
                    long: "--dry-run",
                    description: "Preview what would be synced without writing anything",
                },
            ],
            async run(ctx) {
                const team = ctx.args["team"];
                const stateFilter = ctx.args["state"];
                const limit = ctx.args["limit"] ?? 100;
                const dryRun = ctx.args["dry-run"] ?? false;
                if (!team) {
                    ctx.log.error("--team is required. Example: pm linear sync --team ENG");
                    return { success: false, error: "Missing --team flag" };
                }
                if (dryRun) {
                    ctx.log.info("Running in dry-run mode — no items will be written.");
                }
                try {
                    const result = await syncLinearIssues({ team, stateFilter, limit, dryRun }, ctx.pm, ctx.log);
                    const verb = dryRun ? "Would sync" : "Synced";
                    const summary = `${verb} ${result.synced} issue${result.synced !== 1 ? "s" : ""} from Linear team ${result.team.toUpperCase()}`;
                    if (result.skipped > 0) {
                        ctx.log.info(`${summary} (${result.skipped} skipped by state filter)`);
                    }
                    else {
                        ctx.log.info(summary);
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
                    ctx.log.error(`Linear sync failed: ${message}`);
                    return { success: false, error: message };
                }
            },
        });
        // -----------------------------------------------------------------------
        // Importer: linear-sync
        // -----------------------------------------------------------------------
        api.registerImporter("linear-sync", async ({ config, pm, log }) => {
            const team = config?.["team"] ??
                process.env["LINEAR_DEFAULT_TEAM"];
            if (!team) {
                throw new Error("linear-sync importer requires a 'team' config value or LINEAR_DEFAULT_TEAM env var");
            }
            const limit = config?.["limit"] ?? 100;
            const stateFilter = config?.["state"];
            const result = await syncLinearIssues({ team, stateFilter, limit }, pm, log);
            log.info(`Synced ${result.synced} issues from Linear team ${result.team.toUpperCase()}`);
            return {
                synced: result.synced,
                skipped: result.skipped,
                team: result.team.toUpperCase(),
            };
        });
    },
});
//# sourceMappingURL=index.js.map