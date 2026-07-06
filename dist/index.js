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
// Read --project-map, preserving the "absent vs bare-flag" distinction that a
// plain readStringOption would lose. Returns undefined when the flag was not
// passed at all; "" (passthrough) when passed as a bare boolean flag; otherwise
// the string value. This lets `--project-map` (no value) mean "tag with the
// verbatim project name" while still supporting `--project-map "A=x,B=y"`.
function readProjectMapOption(options) {
    const v = options["project-map"] ?? options[camelKey("project-map")];
    if (v === undefined)
        return undefined;
    if (typeof v === "boolean")
        return v ? "" : undefined;
    return typeof v === "string" ? v : String(v);
}
function normalizeTeam(raw) {
    if (!raw)
        return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
// Resolve the Linear team from --team first, then LINEAR_DEFAULT_TEAM. The
// source is returned so human + JSON output can explain where the team came
// from (important for automation/debugging when defaults are injected).
export function resolveTeamSelection(options, envDefaultTeam = process.env["LINEAR_DEFAULT_TEAM"]) {
    const fromFlag = normalizeTeam(readStringOption(options, "team"));
    if (fromFlag)
        return { team: fromFlag, source: "flag" };
    const fromEnv = normalizeTeam(envDefaultTeam);
    if (fromEnv)
        return { team: fromEnv, source: "env" };
    return undefined;
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
// pm priority → Linear priority (reverse of mapPriority, for export).
// pm:     1=Urgent, 2=High, 3=Medium, 4=Low (and we treat anything else as 0).
// Linear: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low.
// pm 1..4 maps 1:1 onto Linear 1..4; any other value (undefined/0/out-of-range)
// becomes Linear 0 ("No priority") so we never push a bogus int. Pure + exported.
// ---------------------------------------------------------------------------
export function mapPriorityToLinear(pmPriority) {
    if (pmPriority === 1 || pmPriority === 2 || pmPriority === 3 || pmPriority === 4) {
        return pmPriority;
    }
    return 0; // No priority
}
// ---------------------------------------------------------------------------
// Normalize a pm deadline to Linear's `dueDate` shape (a bare YYYY-MM-DD date).
// pm stores deadlines as full ISO datetimes (e.g. "2026-08-01T00:00:00.000Z");
// Linear's TimelessDate wants just the calendar date. We slice the date part of
// any ISO-ish value and pass through an already-bare date untouched. Returns
// undefined for empty/unparseable input. Pure + exported for unit testing.
// ---------------------------------------------------------------------------
export function normalizeDueDate(deadline) {
    if (!deadline)
        return undefined;
    const trimmed = deadline.trim();
    if (!trimmed)
        return undefined;
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : undefined;
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
// precedence over the built-in mapStatus heuristic. The map PRESERVES the
// original key casing (e.g. "In Review", "Backlog") so the export-preview /
// inverted direction can echo the Linear state name as the user typed it;
// matching is done case-insensitively in resolveStatus + lookupStatusOverride.
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
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        // Last writer wins on a case-insensitive key collision; we keep the most
        // recent original-case spelling so the map never silently merges entries.
        if (key && value) {
            const existing = Object.keys(map).find((k) => k.toLowerCase() === key.toLowerCase());
            if (existing)
                delete map[existing];
            map[key] = value;
        }
    }
    return map;
}
// Case-insensitive lookup of the pm status mapped to a Linear state name, using
// a status map whose keys retain their original casing. Pure.
function lookupStatusOverride(statusMap, stateName) {
    const needle = stateName.trim().toLowerCase();
    for (const [key, value] of Object.entries(statusMap)) {
        if (key.trim().toLowerCase() === needle)
            return value;
    }
    return undefined;
}
// Resolve a pm status for an issue, preferring an explicit --status-map entry
// (matched case-insensitively on the Linear state name) over the built-in
// heuristic. Pure.
export function resolveStatus(stateType, stateName, statusMap) {
    const override = lookupStatusOverride(statusMap, stateName);
    if (override)
        return override;
    return mapStatus(stateType, stateName);
}
// ---------------------------------------------------------------------------
// Reverse status mapping (pm status -> Linear workflow-state name) for export.
// Linear has no fixed global state names, so we map to the conventional default
// names every Linear team ships with ("Todo", "In Progress", "Done"). The
// exporter resolves the name to a concrete workflow-state id per team at push
// time; an unresolved name is simply skipped (issue keeps its current state).
// A user-supplied --status-map (parsed normally as Linear=pm) is inverted so
// the same flag round-trips both directions. Pure + exported for testing.
// ---------------------------------------------------------------------------
const DEFAULT_PM_TO_LINEAR_STATE = {
    open: "Todo",
    in_progress: "In Progress",
    blocked: "In Progress",
    closed: "Done",
};
export function invertStatusMap(statusMap) {
    // statusMap is { "<Linear state name, original casing>": "<pm status>" };
    // invert to { "<pm status>": "<Linear state name, original casing>" }. The
    // original casing is preserved so the export preview / push target echoes the
    // state name exactly as the user typed it (e.g. "Backlog", not "backlog").
    // First entry wins on collision.
    const inverted = {};
    for (const [linearName, pmStatus] of Object.entries(statusMap)) {
        const key = pmStatus.trim().toLowerCase();
        if (key && !(key in inverted))
            inverted[key] = linearName;
    }
    return inverted;
}
export function resolveLinearStateName(pmStatus, invertedMap) {
    if (!pmStatus)
        return undefined;
    const key = pmStatus.trim().toLowerCase();
    return invertedMap[key] ?? DEFAULT_PM_TO_LINEAR_STATE[key];
}
export function parseProjectMap(raw) {
    if (raw === undefined)
        return { enabled: false, passthrough: false, map: {} };
    const trimmed = raw.trim();
    // Bare flag / "*" / "true" => passthrough (tag with the verbatim project name).
    if (trimmed === "" || trimmed === "*" || trimmed.toLowerCase() === "true") {
        return { enabled: true, passthrough: true, map: {} };
    }
    const map = {};
    let sawPair = false;
    for (const pair of trimmed.split(",")) {
        const idx = pair.indexOf("=");
        if (idx === -1)
            continue;
        const key = pair.slice(0, idx).trim().toLowerCase();
        const value = pair.slice(idx + 1).trim();
        if (key && value) {
            map[key] = value;
            sawPair = true;
        }
    }
    // A value with no usable pairs (e.g. "garbage") still enables passthrough so
    // the flag is never silently a no-op.
    return { enabled: true, passthrough: !sawPair, map };
}
// Resolve the project tag for an issue's project name under a ProjectMap, or
// undefined when no tag should be applied. Pure + exported for testing.
export function resolveProjectTag(projectName, projectMap) {
    if (!projectMap.enabled)
        return undefined;
    const name = projectName?.trim();
    if (!name)
        return undefined;
    const override = projectMap.map[name.toLowerCase()];
    if (override) {
        return override.toLowerCase() === "ignore" ? undefined : override;
    }
    // No explicit entry: passthrough tags with the verbatim project name; an
    // explicit (non-passthrough) map leaves unmatched projects' own name as the
    // tag so a partial map still tags everything.
    return name;
}
// ---------------------------------------------------------------------------
// Generic field map: --map linearField=pmField[,linearField=pmField...]
// Lets a caller remap which Linear field feeds which pm field at import time
// (e.g. --map identifier=title to drop the "[ENG-1] " prefix, or
// --map priority=ignore to skip priority). Keys are Linear field names; values
// are pm field names (or the sentinel "ignore" to suppress that field).
// Recognized Linear keys: title, description, priority, status, labels,
// assignee, identifier, estimate, customer. Pure + exported for unit testing.
// ---------------------------------------------------------------------------
const KNOWN_LINEAR_FIELDS = [
    "title",
    "description",
    "priority",
    "status",
    "labels",
    "assignee",
    "identifier",
    "estimate",
    "cycle",
    "customer",
];
export function parseFieldMap(raw) {
    const map = {};
    if (!raw)
        return map;
    for (const pair of raw.split(",")) {
        const idx = pair.indexOf("=");
        if (idx === -1)
            continue;
        const key = pair.slice(0, idx).trim().toLowerCase();
        const value = pair.slice(idx + 1).trim().toLowerCase();
        if (key && value)
            map[key] = value;
    }
    return map;
}
// True when the Linear field is suppressed via `--map <field>=ignore`. Pure.
export function fieldIsIgnored(fieldMap, linearField) {
    return fieldMap[linearField.toLowerCase()] === "ignore";
}
// Resolve the pm target field for a given Linear field, honoring an override.
// Returns the override (unless "ignore"), else the Linear field name itself.
// Pure + exported for testing.
export function resolvePmField(fieldMap, linearField) {
    const override = fieldMap[linearField.toLowerCase()];
    if (!override || override === "ignore")
        return linearField.toLowerCase();
    return override;
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
// Build the issues query with only the requested filter clauses + variables.
// Pure + exported so the query-construction logic can be unit tested without
// touching the network.
export function buildIssuesQuery(flags) {
    const clauses = ["team: { key: { eq: $team } }"];
    const vars = ["$team: String!", "$first: Int!", "$after: String"];
    if (flags.project) {
        clauses.push("project: { name: { eq: $project } }");
        vars.push("$project: String!");
    }
    if (flags.assignee) {
        clauses.push("assignee: { email: { eq: $assignee } }");
        vars.push("$assignee: String!");
    }
    if (flags.label) {
        clauses.push("labels: { some: { name: { eq: $label } } }");
        vars.push("$label: String!");
    }
    if (flags.updatedSince) {
        clauses.push("updatedAt: { gte: $updatedSince }");
        vars.push("$updatedSince: DateTimeOrDuration!");
    }
    if (flags.state) {
        // `containsIgnoreCase` preserves the original client-side filter semantics
        // (`stateName.toLowerCase().includes(filter.toLowerCase())`) — a
        // case-insensitive SUBSTRING match — so `--state "progress"` still matches
        // "In Progress". A case-sensitive `eq` here would silently return zero for
        // any lowercase/substring input (a usability regression).
        clauses.push("state: { name: { containsIgnoreCase: $state } }");
        vars.push("$state: String!");
    }
    const filterBody = clauses.map((c) => `      ${c}`).join("\n");
    return `
query(${vars.join(", ")}) {
  issues(
    first: $first
    after: $after
    filter: {
${filterBody}
    }
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      estimate
      state { name type }
      labels { nodes { name } }
      assignee { name email }
      dueDate
      cycle { name }
      project { name }
      customer { name }
      url
    }
    pageInfo { hasNextPage endCursor }
  }
}
`.trim();
}
export function buildImportRequestPlan(team, limit, filters = {}, after = null) {
    const project = filters.project?.trim();
    const assignee = filters.assignee?.trim();
    const label = filters.label?.trim();
    const updatedSince = filters.updatedSince?.trim();
    const state = filters.state?.trim();
    const flags = {
        project: Boolean(project),
        assignee: Boolean(assignee),
        label: Boolean(label),
        updatedSince: Boolean(updatedSince),
        state: Boolean(state),
    };
    const variables = {
        team: team.toUpperCase(),
        first: Math.min(Math.max(limit, 1), LINEAR_MAX_PAGE_SIZE),
        after,
    };
    if (flags.project)
        variables.project = project;
    if (flags.assignee)
        variables.assignee = assignee;
    if (flags.label)
        variables.label = label;
    if (flags.updatedSince)
        variables.updatedSince = updatedSince;
    if (flags.state)
        variables.state = state;
    return {
        endpoint: "https://api.linear.app/graphql",
        method: "POST",
        query: buildIssuesQuery(flags),
        variables,
    };
}
async function fetchAllLinearIssues(apiKey, team, limit, filters = {}) {
    const all = [];
    let after = null;
    while (all.length < limit) {
        const remaining = limit - all.length;
        // buildImportRequestPlan is the single source of truth for query+variables;
        // it caps `first` at the page size. Pass `remaining` so the last page does
        // not over-fetch.
        const plan = buildImportRequestPlan(team, remaining, filters, after);
        const response = await linearRequest(apiKey, plan.query, plan.variables);
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
//
// Robustness: a per-request timeout (default 30s) and exponential backoff retry
// on transient failures (HTTP 429 + 5xx), honoring a Retry-After header when
// present. A retriable HTTP status is surfaced as a RetriableHttpError so the
// retry wrapper can decide; everything else resolves/rejects immediately.
// ---------------------------------------------------------------------------
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;
class RetriableHttpError extends Error {
    status;
    retryAfterMs;
    constructor(status, retryAfterMs) {
        super(`Linear API returned retriable HTTP ${status}`);
        this.name = "RetriableHttpError";
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}
// Compute the delay before the next attempt. Pure + exported for testing.
// `attempt` is zero-based (0 = first retry). Honors an explicit Retry-After.
export function backoffDelayMs(attempt, retryAfterMs) {
    if (typeof retryAfterMs === "number" && retryAfterMs >= 0)
        return retryAfterMs;
    // 250ms, 500ms, 1s, 2s … capped at 8s.
    return Math.min(250 * 2 ** attempt, 8_000);
}
function parseRetryAfter(header) {
    if (!header)
        return undefined;
    const raw = Array.isArray(header) ? header[0] : header;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0)
        return seconds * 1000;
    const date = Date.parse(raw);
    if (!Number.isNaN(date))
        return Math.max(0, date - Date.now());
    return undefined;
}
function linearRequestOnce(apiKey, query, variables) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const req = https.request({
            hostname: "api.linear.app",
            path: "/graphql",
            method: "POST",
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                Authorization: apiKey,
            },
        }, (res) => {
            const status = res.statusCode ?? 0;
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                if (status === 429 || (status >= 500 && status <= 599)) {
                    res.resume();
                    reject(new RetriableHttpError(status, parseRetryAfter(res.headers["retry-after"])));
                    return;
                }
                try {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    resolve(JSON.parse(raw));
                }
                catch (err) {
                    reject(new Error(`Failed to parse Linear response: ${String(err)}`));
                }
            });
        });
        req.on("timeout", () => {
            req.destroy(new RetriableHttpError(0));
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function linearRequest(apiKey, query, variables) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await linearRequestOnce(apiKey, query, variables);
        }
        catch (err) {
            lastErr = err;
            if (!(err instanceof RetriableHttpError) || attempt === MAX_RETRIES)
                break;
            await sleep(backoffDelayMs(attempt, err.retryAfterMs));
        }
    }
    const msg = lastErr instanceof RetriableHttpError
        ? `Linear API unavailable after ${MAX_RETRIES + 1} attempts (HTTP ${lastErr.status || "timeout"})`
        : `Linear request failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`;
    throw new CommandError(msg);
}
const PM_LIST_MAX_BUFFER = 16 * 1024 * 1024;
function readPmItems(pmRoot) {
    const result = spawnSync("pm", ["--path", pmRoot, "--json", "list", "--full", "--include-body", "--limit", "10000"], { encoding: "utf-8", maxBuffer: PM_LIST_MAX_BUFFER });
    if (result.error) {
        throw new CommandError(`pm list failed: ${result.error.message}`);
    }
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
// Index existing pm items by their stored Linear id (parsed from the provenance
// marker) so a re-import can UPDATE the matching item instead of creating a
// duplicate. Items without Linear provenance are ignored. Pure + exported.
export function indexItemsByLinearId(items) {
    const index = {};
    for (const item of items) {
        const prov = parseProvenance(item.description);
        if (prov?.linear_id)
            index[prov.linear_id] = item;
    }
    return index;
}
export function buildItemPlan(issue, statusMap, fieldMap = {}, projectMap = { enabled: false, passthrough: false, map: {} }) {
    // identifier=ignore drops the "[ENG-1] " prefix from the title.
    const prefix = fieldIsIgnored(fieldMap, "identifier")
        ? ""
        : `[${issue.identifier}] `;
    const title = fieldIsIgnored(fieldMap, "title")
        ? `${prefix}(untitled)`
        : `${prefix}${issue.title}`;
    const body = fieldIsIgnored(fieldMap, "description")
        ? ""
        : issue.description ?? "";
    const status = fieldIsIgnored(fieldMap, "status")
        ? "open"
        : resolveStatus(issue.state.type, issue.state.name, statusMap);
    const priority = fieldIsIgnored(fieldMap, "priority")
        ? 3
        : mapPriority(issue.priority);
    const tags = fieldIsIgnored(fieldMap, "labels")
        ? []
        : issue.labels.nodes.map((l) => l.name);
    // --project-map (additive): tag the item with its Linear project name (or a
    // mapped value). De-duplicated against existing label-derived tags.
    const projectTag = resolveProjectTag(issue.project?.name, projectMap);
    if (projectTag && !tags.includes(projectTag))
        tags.push(projectTag);
    // Linear cycle -> a `cycle:<name>` tag. pm has no first-class cycle/sprint
    // field reachable from a standalone extension's `pm create`, so we encode the
    // cycle as a namespaced tag (de-duplicated, additive alongside labels). This
    // keeps the cycle queryable (`pm list --tag "cycle:..."`) without a custom
    // field setter. Suppressed when --map labels=ignore drops tags entirely.
    const cycleName = issue.cycle?.name?.trim();
    if (cycleName && !fieldIsIgnored(fieldMap, "labels")) {
        const cycleTag = `cycle:${cycleName}`;
        if (!tags.includes(cycleTag))
            tags.push(cycleTag);
    }
    if (typeof issue.estimate === "number" && !fieldIsIgnored(fieldMap, "estimate")) {
        const estimateTag = `estimate:${issue.estimate}`;
        if (!tags.includes(estimateTag))
            tags.push(estimateTag);
    }
    const customerName = issue.customer?.name?.trim();
    if (customerName && !fieldIsIgnored(fieldMap, "customer")) {
        const customerTag = `customer:${customerName}`;
        if (!tags.includes(customerTag))
            tags.push(customerTag);
    }
    const plan = {
        title,
        body,
        status,
        priority,
        tags,
        description: buildProvenance(issue),
    };
    if (issue.dueDate)
        plan.deadline = issue.dueDate;
    // Linear assignee -> pm --assignee (email preferred, else display name).
    // Honors --map assignee=ignore.
    if (!fieldIsIgnored(fieldMap, "assignee")) {
        const assignee = issue.assignee?.email?.trim() || issue.assignee?.name?.trim();
        if (assignee)
            plan.assignee = assignee;
    }
    return plan;
}
function buildImportDryRunPlan(options, pm_root) {
    const request = buildImportRequestPlan(options.team, options.limit, {
        project: options.project,
        assignee: options.assignee,
        label: options.label,
        updatedSince: options.updatedSince,
        state: options.stateFilter,
    });
    // Local-only read; no Linear network call. Reports how many already-linked pm
    // items exist so the preview can hint at create-vs-update without fetching.
    let existingLinkedItems = 0;
    try {
        existingLinkedItems = Object.keys(indexItemsByLinearId(readPmItems(pm_root))).length;
    }
    catch {
        existingLinkedItems = 0;
    }
    return {
        dryRun: true,
        team: options.team.toUpperCase(),
        request,
        existingLinkedItems,
        fieldMap: options.fieldMap ?? {},
        statusMap: options.statusMap ?? {},
        projectMap: options.projectMap ?? { enabled: false, passthrough: false, map: {} },
    };
}
async function syncLinearIssues(options, pm_root) {
    const apiKey = process.env["LINEAR_API_KEY"];
    if (!apiKey) {
        throw new CommandError("LINEAR_API_KEY environment variable is not set. " +
            "Get your API key at https://linear.app/settings/api", EXIT_CODE.USAGE);
    }
    const filters = {
        project: options.project,
        assignee: options.assignee,
        label: options.label,
        updatedSince: options.updatedSince,
        state: options.stateFilter,
    };
    // --dry-run is fully OFFLINE: build and PRINT the exact GraphQL request that
    // WOULD be sent (query + variables), make NO network call, and report against
    // the local workspace only. This is handled in the command/importer handler
    // (which has access to the JSON-mode flag); syncLinearIssues is only reached
    // here for real writes, so a missing/invalid key surfaces as a real error.
    const scopeBits = [];
    if (options.project)
        scopeBits.push(`project "${options.project}"`);
    if (options.assignee)
        scopeBits.push(`assignee ${options.assignee}`);
    if (options.label)
        scopeBits.push(`label "${options.label}"`);
    if (options.updatedSince)
        scopeBits.push(`updated since ${options.updatedSince}`);
    if (options.stateFilter)
        scopeBits.push(`state "${options.stateFilter}"`);
    const scope = scopeBits.length ? ` (${scopeBits.join(", ")})` : "";
    console.error(`Fetching issues from Linear team: ${options.team}${scope} (limit: ${options.limit})`);
    const issues = await fetchAllLinearIssues(apiKey, options.team, options.limit, filters);
    if (issues.length === 0) {
        console.error(`No issues found for team "${options.team}"${scope}. Check the team slug, filters, and your API key permissions.`);
        return { synced: 0, created: 0, updated: 0, skipped: 0, team: options.team, issues: [] };
    }
    const statusMap = options.statusMap ?? {};
    // Idempotency: index existing items by stored Linear id so a re-import
    // UPDATES the matching item rather than creating a duplicate. We only read
    // the workspace when actually writing (dry-run is read-free on Linear's side
    // but we still want the preview to report create-vs-update accurately).
    const existingByLinearId = indexItemsByLinearId(readPmItems(pm_root));
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const issue of issues) {
        // State name filter. The authoritative constraint is now server-side
        // (`state: { name: { containsIgnoreCase: $state } }` in buildIssuesQuery),
        // so `--limit` bounds the MATCHING issues rather than the pre-filter page.
        // This identical case-insensitive substring check is a harmless backstop —
        // the server applies the same predicate, so it never drops a server hit.
        if (options.stateFilter) {
            const stateName = issue.state.name.toLowerCase();
            if (!stateName.includes(options.stateFilter.toLowerCase())) {
                skipped++;
                continue;
            }
        }
        // `pm create` has no generic setter for the registerItemFields custom
        // fields from a standalone extension, so buildItemPlan persists Linear
        // provenance in the description behind a stable marker. This survives
        // round-trips and is what re-import + `pm linear export` read back to stay
        // idempotent. The same builder feeds the offline --dry-run preview.
        const plan = buildItemPlan(issue, statusMap, options.fieldMap ?? {}, options.projectMap ?? { enabled: false, passthrough: false, map: {} });
        const { title, body, status, priority, description } = plan;
        const tags = plan.tags;
        const existing = existingByLinearId[issue.id];
        if (existing && existing.id) {
            // Update the matched item in place (no duplicate).
            const updateArgs = [
                "--path", pm_root,
                "update", existing.id,
                "--title", title,
                "--status", status,
                "--priority", String(priority),
                "--description", description,
            ];
            if (body)
                updateArgs.push("--body", body);
            if (tags.length > 0)
                updateArgs.push("--tags", tags.join(","));
            if (plan.deadline)
                updateArgs.push("--deadline", plan.deadline);
            if (plan.assignee)
                updateArgs.push("--assignee", plan.assignee);
            const result = spawnSync("pm", updateArgs, { encoding: "utf-8" });
            if (result.status !== 0) {
                console.error(`Failed to update item for ${issue.identifier}: ${result.stderr}`);
                skipped++;
                continue;
            }
            updated++;
        }
        else {
            const createArgs = [
                "--path", pm_root,
                "create",
                "--title", title,
                "--status", status,
                "--priority", String(priority),
                "--description", description,
            ];
            if (body)
                createArgs.push("--body", body);
            if (tags.length > 0)
                createArgs.push("--tags", tags.join(","));
            if (plan.deadline)
                createArgs.push("--deadline", plan.deadline);
            if (plan.assignee)
                createArgs.push("--assignee", plan.assignee);
            const result = spawnSync("pm", createArgs, { encoding: "utf-8" });
            if (result.status !== 0) {
                console.error(`Failed to create item for ${issue.identifier}: ${result.stderr}`);
                skipped++;
                continue;
            }
            created++;
        }
    }
    return {
        synced: created + updated,
        created,
        updated,
        skipped,
        team: options.team,
        issues,
    };
}
// Pull a single integer estimate out of pm tags shaped `estimate:<n>` (mirrors
// the importer's Linear-estimate -> tag mapping). Returns the parsed finite int
// or undefined. Pure + exported for testing. Last well-formed tag wins.
export function parseEstimateTag(tags) {
    let result;
    for (const t of tags) {
        const m = /^estimate:(.+)$/i.exec(t.trim());
        if (!m)
            continue;
        const n = Number(m[1].trim());
        if (Number.isFinite(n))
            result = n;
    }
    return result;
}
// Pull a cycle NAME out of pm tags shaped `cycle:<name>` (mirrors the importer's
// Linear-cycle -> tag mapping). Returns the trimmed name or undefined. Pure +
// exported for testing. Last non-empty tag wins.
export function parseCycleTag(tags) {
    let result;
    for (const t of tags) {
        const m = /^cycle:(.+)$/i.exec(t.trim());
        if (!m)
            continue;
        const name = m[1].trim();
        if (name)
            result = name;
    }
    return result;
}
// True when a tag is one of the namespaced round-trip encodings the exporter
// promotes to first-class issue fields (estimate/cycle) rather than a Linear
// label. Pure: keeps those tags from being emitted as labels (Linear would
// reject them as unknown label names anyway).
export function isReservedExportTag(tag) {
    const t = tag.trim().toLowerCase();
    return t.startsWith("estimate:") || t.startsWith("cycle:");
}
// Pure transform: pm item -> Linear issue payload. Items that already carry
// Linear provenance are flagged (and keep their linear id) so `--push` UPDATES
// them in place instead of creating a duplicate. priority/labels/dueDate mirror
// the importer's Linear->pm mapping so an exported item round-trips its
// priority, tags (as labels), and deadline (as dueDate).
export function itemToLinearPayload(item, fieldMap = {}) {
    const provenance = parseProvenance(item.description);
    const rawTags = Array.isArray(item.tags)
        ? item.tags.map((t) => String(t).trim()).filter((t) => t.length > 0)
        : [];
    // Promote the importer's namespaced round-trip tags (estimate:/cycle:) to
    // first-class Linear fields, honoring --map suppression. The corresponding
    // tags are then excluded from `labels` so they are NOT (re)emitted as Linear
    // labels — Linear would reject `estimate:5`/`cycle:Q3` as unknown label names,
    // and emitting them would be a confusing double-encoding.
    const estimate = fieldIsIgnored(fieldMap, "estimate")
        ? undefined
        : parseEstimateTag(rawTags);
    const cycleName = fieldIsIgnored(fieldMap, "cycle")
        ? undefined
        : parseCycleTag(rawTags);
    const labels = rawTags.filter((t) => !isReservedExportTag(t));
    const payload = {
        title: item.title ?? "(untitled)",
        description: item.body || (provenance ? "" : item.description || ""),
        pmId: item.id,
        pmStatus: item.status,
        priority: mapPriorityToLinear(item.priority),
        labels,
        alreadyInLinear: provenance !== undefined,
        linearId: provenance?.linear_id || undefined,
        linearUrl: provenance?.linear_url || undefined,
    };
    if (typeof estimate === "number")
        payload.estimate = estimate;
    if (cycleName)
        payload.cycleName = cycleName;
    const dueDate = normalizeDueDate(item.deadline);
    if (dueDate)
        payload.dueDate = dueDate;
    return payload;
}
// Resolve a Linear team key (e.g. "ENG") to its internal id for issueCreate,
// and fetch its workflow states so the exporter can map pm status -> a real
// state id when pushing. One round-trip.
const TEAM_QUERY = `
query($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes {
      id
      states { nodes { id name } }
      labels { nodes { id name } }
      cycles { nodes { id name number } }
    }
  }
}
`.trim();
const ISSUE_CREATE_MUTATION = `
mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}
`.trim();
const ISSUE_UPDATE_MUTATION = `
mutation($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id identifier url } }
}
`.trim();
async function resolveTeamContext(apiKey, teamKey) {
    const resp = await linearRequest(apiKey, TEAM_QUERY, { key: teamKey.toUpperCase() });
    if (resp.errors?.length) {
        throw new CommandError(`Linear API error resolving team ${teamKey}: ${resp.errors.map((e) => e.message).join("; ")}`);
    }
    const node = resp.data?.teams?.nodes?.[0];
    if (!node?.id) {
        throw new CommandError(`Linear team "${teamKey}" not found.`, EXIT_CODE.NOT_FOUND);
    }
    const statesByName = {};
    for (const s of node.states?.nodes ?? []) {
        if (s?.name && s?.id)
            statesByName[String(s.name).trim().toLowerCase()] = s.id;
    }
    const labelsByName = {};
    for (const l of node.labels?.nodes ?? []) {
        if (l?.name && l?.id)
            labelsByName[String(l.name).trim().toLowerCase()] = l.id;
    }
    const cyclesByName = {};
    for (const c of node.cycles?.nodes ?? []) {
        if (!c?.id)
            continue;
        if (c.name)
            cyclesByName[String(c.name).trim().toLowerCase()] = c.id;
        // Numbered cycles often have no name; index by number too so a
        // `cycle:42` tag still resolves.
        if (c.number != null)
            cyclesByName[String(c.number).trim().toLowerCase()] = c.id;
    }
    return { teamId: node.id, statesByName, labelsByName, cyclesByName };
}
// Resolve pm tags (label names) to existing Linear label ids for this team.
// Unknown names are silently dropped so a push never fails on a tag the team
// doesn't model. Pure + exported for unit testing.
export function resolveLabelIds(labels, labelsByName) {
    if (!labels?.length)
        return [];
    const ids = [];
    for (const name of labels) {
        const id = labelsByName[name.trim().toLowerCase()];
        if (id && !ids.includes(id))
            ids.push(id);
    }
    return ids;
}
// Resolve a Linear cycle NAME (or number) to its concrete cycle id for this
// team. Returns undefined when the name does not match any cycle (offline,
// unknown, or a workspace that doesn't model the cycle) so the push can skip
// the field gracefully rather than crash. Pure + exported for unit testing.
export function resolveCycleId(cycleName, cyclesByName) {
    if (!cycleName)
        return undefined;
    return cyclesByName[cycleName.trim().toLowerCase()];
}
// Apply estimate + (resolved) cycleId onto a REAL push input (issueCreate or
// issueUpdate). estimate is a finite number copied straight through. cycle is
// resolved by name to a concrete id via the team context; an unresolvable cycle
// is skipped (NOT crashed) and warned about once per process so a batch push of
// many items isn't spammed. Returns the (possibly mutated) input for chaining.
let warnedUnresolvedCycle = false;
export function resetCycleWarning() {
    warnedUnresolvedCycle = false;
}
export function applyPushDynamicFields(input, payload, cyclesByName, warn = (m) => console.error(m)) {
    if (typeof payload.estimate === "number" && Number.isFinite(payload.estimate)) {
        input.estimate = payload.estimate;
    }
    if (payload.cycleName) {
        const cycleId = resolveCycleId(payload.cycleName, cyclesByName);
        if (cycleId) {
            input.cycleId = cycleId;
        }
        else if (!warnedUnresolvedCycle) {
            warnedUnresolvedCycle = true;
            warn(`Linear cycle "${payload.cycleName}" did not match any cycle on the team; ` +
                `skipping cycle assignment (further unresolved cycles suppressed).`);
        }
    }
}
// Apply the priority/labels/dueDate fields onto an issue input, symmetric with
// the importer. priority is included whenever it resolves to a concrete Linear
// int (including 0 = "No priority", which is a valid explicit clear). labels are
// passed through by NAME in the offline plan as `labelNames` (a placeholder the
// real push resolves to `labelIds` per team); an empty list is omitted. dueDate
// is the bare YYYY-MM-DD. Pure helper so the plan + the real push agree. The
// `labelIds` placeholder string makes the offline dry-run self-documenting about
// how names become ids at push time without inventing fake ids.
function applyExportFields(input, payload) {
    if (typeof payload.priority === "number")
        input.priority = payload.priority;
    if (payload.labels && payload.labels.length > 0) {
        input.labelNames = payload.labels;
        input.labelIds = payload.labels.map((n) => `<label-id-for:${n}>`);
    }
    if (payload.dueDate)
        input.dueDate = payload.dueDate;
    // estimate round-trips as a finite integer (mirrors the importer's
    // `estimate:<n>` tag). 0 is a valid explicit estimate.
    if (typeof payload.estimate === "number" && Number.isFinite(payload.estimate)) {
        input.estimate = payload.estimate;
    }
    // cycle round-trips by NAME; the concrete cycleId is only knowable with creds
    // at push time, so the offline plan carries both the name and a self-
    // documenting `cycleId` placeholder (symmetric with the labelIds placeholder).
    if (payload.cycleName) {
        input.cycleName = payload.cycleName;
        input.cycleId = `<cycle-id-for:${payload.cycleName}>`;
    }
}
export function buildExportMutationPlan(payload, invertedStatusMap, teamKey) {
    const targetStateName = resolveLinearStateName(payload.pmStatus, invertedStatusMap) ?? null;
    if (payload.alreadyInLinear && payload.linearId) {
        const input = {
            title: payload.title,
            description: payload.description,
        };
        if (targetStateName)
            input.stateName = targetStateName;
        applyExportFields(input, payload);
        return {
            action: "update",
            mutation: ISSUE_UPDATE_MUTATION,
            variables: { id: payload.linearId, input },
            targetStateName,
        };
    }
    const input = {
        teamId: teamKey ? `<resolved-id-for-${teamKey.toUpperCase()}>` : "<team-id>",
        title: payload.title,
        description: payload.description,
    };
    if (targetStateName)
        input.stateName = targetStateName;
    applyExportFields(input, payload);
    return {
        action: "create",
        mutation: ISSUE_CREATE_MUTATION,
        variables: { input },
        targetStateName,
    };
}
// ---------------------------------------------------------------------------
// Preflight — credential + reachability validation for mutating Linear calls.
//
// pm's preflight runtime swallows thrown errors (a throw aborts the override,
// not the command), so we cannot reject from inside the override. Instead the
// preflight does the cheap validation and, on failure, injects a sentinel
// option that the command/importer/exporter handlers read and turn into a
// clean CommandError. This keeps the `preflight` capability load-bearing.
// ---------------------------------------------------------------------------
const PREFLIGHT_ERROR_OPTION = "__linear_preflight_error";
// Commands that actually mutate Linear/the workspace and therefore need a key.
// `linear export` is gated only when --push is present.
function commandMutatesLinear(command, options) {
    const cmd = command.trim().toLowerCase();
    if (cmd === "linear sync" || cmd === "linear import") {
        return !readBooleanOption(options, "dry-run");
    }
    if (cmd === "linear export") {
        return readBooleanOption(options, "push");
    }
    return false;
}
// Validate that the credential needed for a mutating Linear call is present and
// (best-effort) that the API is reachable. Returns an error string or null.
// Reachability check is skipped when SKIP_NETWORK is requested so unit/offline
// runs stay deterministic.
async function preflightLinear(options, checkReachability) {
    const apiKey = process.env["LINEAR_API_KEY"];
    if (!apiKey) {
        return ("LINEAR_API_KEY is not set. Linear operations that write data require an " +
            "API key. Get one at https://linear.app/settings/api and `export LINEAR_API_KEY=...`.");
    }
    if (!checkReachability)
        return null;
    try {
        const resp = await linearRequest(apiKey, "query { viewer { id } }", {});
        if (resp.errors?.length) {
            return `Linear API rejected the credentials: ${resp.errors.map((e) => e.message).join("; ")}`;
        }
        if (!resp.data?.viewer?.id) {
            return "Linear API reachable but returned no viewer; check the API key scope.";
        }
        return null;
    }
    catch (err) {
        return `Linear API unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
}
// Mask an API key for diagnostics: never reveal more than a short prefix.
// Pure + exported for testing. "" / undefined -> "".
export function maskApiKey(key) {
    if (!key)
        return "";
    const head = key.slice(0, 4);
    return `${head}…(${key.length} chars)`;
}
function buildValidationReport() {
    const key = process.env["LINEAR_API_KEY"];
    const apiKeyPresent = Boolean(key);
    return {
        apiKeyPresent,
        apiKeyMasked: maskApiKey(key),
        defaultTeam: process.env["LINEAR_DEFAULT_TEAM"],
        readyForWrites: apiKeyPresent,
        networkChecked: false,
        networkOk: false,
    };
}
// Read + clear the sentinel a preflight may have injected; throw if present.
function assertPreflightOk(options) {
    const err = options[PREFLIGHT_ERROR_OPTION];
    if (typeof err === "string" && err) {
        throw new CommandError(err, EXIT_CODE.USAGE);
    }
}
// True when the caller passed the GLOBAL --json flag. pm exposes it on
// ctx.global.json; in JSON mode handlers return the object and must NOT write
// their own stdout (the runtime serializes the return value).
function isJsonMode(ctx) {
    return Boolean(ctx?.global?.json);
}
// Render an offline import dry-run: build the literal GraphQL request (no
// network) and either return the plan object (JSON mode) or print a human
// preview to stderr. Shared by `linear sync` and the `linear` importer so both
// dry-run paths are identical and network-free. Returns the JSON-mode payload.
function renderImportDryRun(ctx, options, teamSource) {
    const plan = buildImportDryRunPlan(options, ctx.pm_root);
    if (!isJsonMode(ctx)) {
        if (teamSource === "env") {
            console.error(`Using LINEAR_DEFAULT_TEAM=${plan.team} (no --team provided).`);
        }
        console.error("Running in dry-run mode — no Linear network call is made.");
        console.error(`Target team: ${plan.team} (limit: ${options.limit})`);
        console.error(`GraphQL endpoint: ${plan.request.method} ${plan.request.endpoint}`);
        console.error("GraphQL query:");
        console.error(plan.request.query);
        console.error("GraphQL variables:");
        console.error(JSON.stringify(plan.request.variables, null, 2));
        console.error(`Existing Linear-linked pm items: ${plan.existingLinkedItems} ` +
            `(matched issues would update; the rest would be created).`);
        if (Object.keys(plan.statusMap).length) {
            console.error(`Status map: ${JSON.stringify(plan.statusMap)}`);
        }
        if (Object.keys(plan.fieldMap).length) {
            console.error(`Field map: ${JSON.stringify(plan.fieldMap)}`);
        }
        if (plan.projectMap.enabled) {
            console.error(`Project map: ${plan.projectMap.passthrough
                ? "passthrough (tag = Linear project name)"
                : JSON.stringify(plan.projectMap.map)}`);
        }
    }
    return {
        success: true,
        dryRun: true,
        team: plan.team,
        request: plan.request,
        existingLinkedItems: plan.existingLinkedItems,
        statusMap: plan.statusMap,
        fieldMap: plan.fieldMap,
        projectMap: plan.projectMap,
        ...(teamSource ? { teamSource } : {}),
    };
}
// ---------------------------------------------------------------------------
// Extension definition
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-linear",
    version: "2026.7.6",
    activate(api) {
        // -----------------------------------------------------------------------
        // preflight — validate credentials + reachability before any mutating
        // Linear command runs. On failure it injects a sentinel option (it cannot
        // abort by throwing) that the handlers convert into a clean USAGE error.
        // -----------------------------------------------------------------------
        api.registerPreflight(async (ctx) => {
            if (!commandMutatesLinear(ctx.command, ctx.options))
                return {};
            // Reachability uses the network; allow opting out (CI/offline/tests).
            // pm strips a leading `--no-` as boolean negation, so the user-facing flag
            // is `--skip-preflight-network` (the legacy `no-preflight-network` key is
            // still honored for back-compat with any existing scripts/config).
            const checkReachability = !readBooleanOption(ctx.options, "skip-preflight-network") &&
                !readBooleanOption(ctx.options, "no-preflight-network") &&
                process.env["LINEAR_PREFLIGHT_NO_NETWORK"] !== "1";
            const error = await preflightLinear(ctx.options, checkReachability);
            if (!error)
                return {};
            return { options: { ...ctx.options, [PREFLIGHT_ERROR_OPTION]: error } };
        });
        // -----------------------------------------------------------------------
        // Command: pm linear sync
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "linear sync",
            description: "Sync Linear.app issues into pm items",
            intent: "Fetch issues from a Linear team and upsert them as pm items",
            examples: [
                "pm linear sync --team ENG",
                "LINEAR_DEFAULT_TEAM=ENG pm linear sync",
                "pm linear sync --team ENG --state 'In Progress'",
                "pm linear sync --team ENG --assignee dev@acme.com --label bug",
                "pm linear sync --team ENG --limit 50",
                "pm linear sync --team ENG --dry-run",
            ],
            flags: [
                { long: "--team", value_name: "slug", description: "Linear team slug (e.g. ENG, BACKEND). Optional when LINEAR_DEFAULT_TEAM is set." },
                { long: "--project", value_name: "name", description: "Filter by Linear project name. Optional." },
                { long: "--state", value_name: "name", description: "Filter by Linear state name (e.g. 'In Progress', 'Todo'). Optional." },
                { long: "--assignee", value_name: "email", description: "Filter by assignee email. Optional." },
                { long: "--label", value_name: "name", description: "Filter by label name. Optional." },
                { long: "--updated-since", value_name: "date", description: "Only issues updated at/after this ISO date or duration (e.g. 2026-01-01, -P7D). Optional." },
                { long: "--status-map", value_name: "map", description: "Override status mapping, e.g. \"In Review=in_progress,Backlog=open\". Optional." },
                { long: "--map", value_name: "map", description: "Remap Linear->pm fields, e.g. \"identifier=ignore,priority=ignore\". Optional." },
                { long: "--project-map", value_name: "map", description: "Tag items by Linear project name. Bare flag tags with the verbatim name; \"Mobile=mobile,Web=web\" remaps. Optional." },
                { long: "--limit", value_name: "n", description: "Maximum number of issues to fetch (default: 100)" },
                { long: "--dry-run", description: "Preview the exact GraphQL request without any network call or writes" },
                { long: "--skip-preflight-network", description: "Skip the preflight reachability probe (offline/CI)" },
            ],
            async run(ctx) {
                assertPreflightOk(ctx.options);
                const teamSelection = resolveTeamSelection(ctx.options);
                if (!teamSelection) {
                    throw new CommandError("Missing Linear team. Pass --team <slug> or set LINEAR_DEFAULT_TEAM. " +
                        "Example: pm linear sync --team ENG", EXIT_CODE.USAGE);
                }
                const team = teamSelection.team;
                const project = readStringOption(ctx.options, "project");
                const stateFilter = readStringOption(ctx.options, "state");
                const assignee = readStringOption(ctx.options, "assignee");
                const label = readStringOption(ctx.options, "label");
                const updatedSince = readStringOption(ctx.options, "updated-since");
                const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
                const fieldMap = parseFieldMap(readStringOption(ctx.options, "map"));
                const projectMap = parseProjectMap(readProjectMapOption(ctx.options));
                const limit = readNumberOption(ctx.options, "limit") ?? 100;
                const dryRun = readBooleanOption(ctx.options, "dry-run");
                const syncOpts = {
                    team, project, stateFilter, assignee, label, updatedSince,
                    statusMap, fieldMap, projectMap, limit, dryRun,
                };
                // --dry-run is fully offline: print the literal GraphQL request, no call.
                if (dryRun) {
                    return renderImportDryRun(ctx, syncOpts, teamSelection.source);
                }
                if (!isJsonMode(ctx) && teamSelection.source === "env") {
                    console.error(`Using LINEAR_DEFAULT_TEAM=${team.toUpperCase()} (no --team provided).`);
                }
                try {
                    const result = await syncLinearIssues(syncOpts, ctx.pm_root);
                    const summary = `Synced ${result.synced} issue${result.synced !== 1 ? "s" : ""} ` +
                        `(${result.created} new, ${result.updated} updated) from Linear team ${result.team.toUpperCase()}`;
                    if (result.skipped > 0) {
                        console.error(`${summary} (${result.skipped} skipped)`);
                    }
                    else {
                        console.error(summary);
                    }
                    return {
                        success: true,
                        synced: result.synced,
                        created: result.created,
                        updated: result.updated,
                        skipped: result.skipped,
                        team: result.team.toUpperCase(),
                        teamSource: teamSelection.source,
                        dryRun: false,
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
        // Command: pm linear validate — readiness diagnostics. Reports whether the
        // API key + default team are configured WITHOUT leaking the key, and
        // whether push-on-write is enabled. Offline by default; --check-network
        // (opt-in) probes the Linear API. --json returns the structured object.
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "linear validate",
            description: "Check pm-linear configuration + Linear API readiness",
            intent: "Report whether LINEAR_API_KEY and team config are present (without leaking the key)",
            examples: [
                "pm linear validate",
                "pm linear validate --json",
                "pm linear validate --check-network",
            ],
            flags: [
                { long: "--check-network", description: "Probe the Linear API to confirm the key is accepted (needs network)." },
            ],
            async run(ctx) {
                const checkNetwork = readBooleanOption(ctx.options, "check-network");
                const diag = buildValidationReport();
                if (checkNetwork && diag.apiKeyPresent) {
                    const err = await preflightLinear(ctx.options, true);
                    diag.networkChecked = true;
                    diag.networkOk = err === null;
                    if (err)
                        diag.networkError = err;
                }
                if (isJsonMode(ctx))
                    return diag;
                console.error(`Linear API key:      ${diag.apiKeyPresent ? `present (${diag.apiKeyMasked})` : "MISSING"}`);
                console.error(`Default team:        ${diag.defaultTeam ?? "(not set)"}`);
                if (diag.networkChecked) {
                    console.error(`API reachability:    ${diag.networkOk ? "ok" : `FAILED — ${diag.networkError}`}`);
                }
                console.error(`Ready for writes:    ${diag.readyForWrites ? "yes" : "no — set LINEAR_API_KEY"}`);
                return diag;
            },
        });
        // -----------------------------------------------------------------------
        // schema — declare Linear provenance fields so the workspace knows them
        // -----------------------------------------------------------------------
        api.registerItemFields([
            { name: "linear_id", type: "string", optional: true },
            { name: "linear_url", type: "string", optional: true },
        ]);
        // Surface importer/exporter flags in help. The importer/exporter read these
        // off ctx.options regardless, but declaring them makes `pm linear import
        // --help` / `pm linear export --help` self-documenting.
        api.registerFlags("linear import", [
            { long: "--team", value_name: "slug", description: "Linear team slug. Optional when LINEAR_DEFAULT_TEAM is set." },
            { long: "--project", value_name: "name", description: "Filter by Linear project name." },
            { long: "--state", value_name: "name", description: "Filter by Linear state name." },
            { long: "--assignee", value_name: "email", description: "Filter by assignee email." },
            { long: "--label", value_name: "name", description: "Filter by label name." },
            { long: "--updated-since", value_name: "date", description: "Only issues updated at/after this ISO date or duration." },
            { long: "--status-map", value_name: "map", description: "Override status mapping, e.g. \"In Review=in_progress\"." },
            { long: "--map", value_name: "map", description: "Remap Linear->pm fields, e.g. \"identifier=ignore\"." },
            { long: "--project-map", value_name: "map", description: "Tag items by Linear project name (bare flag = verbatim; \"Mobile=mobile\" remaps)." },
            { long: "--limit", value_name: "n", description: "Maximum number of issues to fetch (default: 100)." },
            { long: "--dry-run", description: "Print the exact GraphQL request offline (no network, no writes)." },
        ]);
        api.registerFlags("linear export", [
            { long: "--push", description: "Create/update the issues in Linear (requires LINEAR_API_KEY + --team)." },
            { long: "--team", value_name: "slug", description: "Target Linear team slug (required with --push when LINEAR_DEFAULT_TEAM is unset)." },
            { long: "--status-map", value_name: "map", description: "pm-status<->Linear-state map; inverted for the push direction." },
            { long: "--map", value_name: "map", description: "Suppress export fields, e.g. \"estimate=ignore,cycle=ignore\". Optional." },
            { long: "--dry-run", description: "Print the would-be Linear mutations (no network) — works with or without --push." },
        ]);
        // -----------------------------------------------------------------------
        // importer — `pm linear import` (native import pipeline; pulls issues via
        // the Linear GraphQL API and creates pm items, reusing the sync core).
        // -----------------------------------------------------------------------
        api.registerImporter("linear", async (ctx) => {
            assertPreflightOk(ctx.options);
            const teamSelection = resolveTeamSelection(ctx.options);
            if (!teamSelection) {
                throw new CommandError("Missing Linear team. Pass --team <slug> or set LINEAR_DEFAULT_TEAM. " +
                    "Example: pm linear import --team ENG", EXIT_CODE.USAGE);
            }
            const team = teamSelection.team;
            const project = readStringOption(ctx.options, "project");
            const stateFilter = readStringOption(ctx.options, "state");
            const assignee = readStringOption(ctx.options, "assignee");
            const label = readStringOption(ctx.options, "label");
            const updatedSince = readStringOption(ctx.options, "updated-since");
            const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
            const fieldMap = parseFieldMap(readStringOption(ctx.options, "map"));
            const projectMap = parseProjectMap(readProjectMapOption(ctx.options));
            const limit = readNumberOption(ctx.options, "limit") ?? 100;
            const dryRun = readBooleanOption(ctx.options, "dry-run");
            const syncOpts = {
                team, project, stateFilter, assignee, label, updatedSince,
                statusMap, fieldMap, projectMap, limit, dryRun,
            };
            // --dry-run is fully offline: emit the literal GraphQL request, no call.
            if (dryRun) {
                const plan = renderImportDryRun(ctx, syncOpts, teamSelection.source);
                return { imported: 0, created: 0, updated: 0, skipped: 0, ...plan };
            }
            if (!isJsonMode(ctx) && teamSelection.source === "env") {
                console.error(`Using LINEAR_DEFAULT_TEAM=${team.toUpperCase()} (no --team provided).`);
            }
            try {
                const result = await syncLinearIssues(syncOpts, ctx.pm_root);
                console.error(`Imported ${result.synced} issue(s) (${result.created} new, ${result.updated} updated) ` +
                    `from Linear team ${result.team.toUpperCase()}` +
                    (result.skipped > 0 ? ` (${result.skipped} skipped)` : ""));
                return {
                    imported: result.synced,
                    created: result.created,
                    updated: result.updated,
                    skipped: result.skipped,
                    team: result.team.toUpperCase(),
                    teamSource: teamSelection.source,
                    dryRun: false,
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
            assertPreflightOk(ctx.options);
            const push = readBooleanOption(ctx.options, "push");
            const dryRun = readBooleanOption(ctx.options, "dry-run");
            const invertedStatusMap = invertStatusMap(parseStatusMap(readStringOption(ctx.options, "status-map")));
            const teamSelection = resolveTeamSelection(ctx.options);
            const teamKey = teamSelection?.team;
            const fieldMap = parseFieldMap(readStringOption(ctx.options, "map"));
            const items = readPmItems(ctx.pm_root);
            const payloads = items.map((it) => itemToLinearPayload(it, fieldMap));
            // --dry-run: build + print the exact would-be Linear GraphQL mutations
            // (issueCreate / issueUpdate with their variables), OFFLINE — no network,
            // no writes — regardless of --push. This is the symmetric counterpart to
            // the import dry-run plan.
            if (dryRun) {
                const plans = payloads.map((p) => buildExportMutationPlan(p, invertedStatusMap, teamKey));
                const wouldCreate = plans.filter((p) => p.action === "create").length;
                const wouldUpdate = plans.length - wouldCreate;
                if (!isJsonMode(ctx)) {
                    console.error(`[dry-run] Would push ${plans.length} item(s): ${wouldCreate} create, ${wouldUpdate} update. No network call made.`);
                    if (!teamKey && wouldCreate > 0) {
                        console.error("[dry-run] No team resolved for create payloads. Pass --team <slug> " +
                            "or set LINEAR_DEFAULT_TEAM to render team-specific placeholders.");
                    }
                    for (const plan of plans) {
                        console.error(`--- ${plan.action} ---`);
                        console.error(plan.mutation);
                        console.error(JSON.stringify(plan.variables, null, 2));
                    }
                }
                return {
                    exported: plans.length,
                    pushed: false,
                    dryRun: true,
                    wouldCreate,
                    wouldUpdate,
                    mutations: plans,
                    ...(teamKey ? { team: teamKey.toUpperCase(), teamSource: teamSelection?.source } : {}),
                };
            }
            // Default (no --push, no --dry-run): print the read-only payload preview.
            if (!push) {
                const printable = payloads.map((p) => ({
                    action: p.alreadyInLinear ? "update" : "create",
                    title: p.title,
                    description: p.description,
                    targetState: resolveLinearStateName(p.pmStatus, invertedStatusMap) ?? null,
                    priority: p.priority ?? 0,
                    ...(p.labels && p.labels.length ? { labels: p.labels } : {}),
                    ...(p.dueDate ? { dueDate: p.dueDate } : {}),
                    ...(typeof p.estimate === "number" ? { estimate: p.estimate } : {}),
                    ...(p.cycleName ? { cycle: p.cycleName } : {}),
                    ...(p.linearId ? { linearId: p.linearId } : {}),
                    ...(p.linearUrl ? { linearUrl: p.linearUrl } : {}),
                }));
                const wouldCreate = printable.filter((p) => p.action === "create").length;
                const wouldUpdate = printable.length - wouldCreate;
                if (isJsonMode(ctx)) {
                    return {
                        exported: printable.length,
                        pushed: false,
                        dryRun: false,
                        wouldCreate,
                        wouldUpdate,
                        payloads: printable,
                        ...(teamKey ? { team: teamKey.toUpperCase(), teamSource: teamSelection?.source } : {}),
                    };
                }
                if (!teamKey && wouldCreate > 0) {
                    console.error("[preview] No team resolved for create payloads. Pass --team <slug> " +
                        "or set LINEAR_DEFAULT_TEAM to preview team-specific placeholders.");
                }
                console.log(JSON.stringify(printable, null, 2));
                return {
                    exported: printable.length,
                    pushed: false,
                    dryRun: false,
                    wouldCreate,
                    wouldUpdate,
                    ...(teamKey ? { team: teamKey.toUpperCase(), teamSource: teamSelection?.source } : {}),
                };
            }
            // Real push. Preflight has already validated the key + reachability; the
            // explicit checks below keep the contract self-evident at the call site.
            const apiKey = process.env["LINEAR_API_KEY"];
            if (!apiKey) {
                throw new CommandError("--push requires LINEAR_API_KEY. Get a key at https://linear.app/settings/api", EXIT_CODE.USAGE);
            }
            if (!teamSelection) {
                throw new CommandError("--push requires --team <slug> (or LINEAR_DEFAULT_TEAM).", EXIT_CODE.USAGE);
            }
            const team = teamSelection.team;
            if (!isJsonMode(ctx) && teamSelection.source === "env") {
                console.error(`Using LINEAR_DEFAULT_TEAM=${team.toUpperCase()} (no --team provided).`);
            }
            const teamCtx = await resolveTeamContext(apiKey, team);
            // Fresh warn-once budget per push invocation so a later batch isn't muted
            // by an earlier one in the same process.
            resetCycleWarning();
            let created = 0;
            let updated = 0;
            let skipped = 0;
            // Per-item failure isolation: a single issueCreate/issueUpdate failure
            // (API error, transient network, etc.) is caught, counted into `skipped`,
            // and the batch CONTINUES — mirroring the import path's per-item `continue`
            // — instead of aborting every remaining item. Errors are logged to stderr.
            for (const payload of payloads) {
                const label = payload.linearId ?? payload.pmId ?? payload.title;
                try {
                    // Map pm status -> a concrete Linear workflow-state id for this team,
                    // when one resolves; otherwise leave the state untouched.
                    const stateName = resolveLinearStateName(payload.pmStatus, invertedStatusMap);
                    const stateId = stateName
                        ? teamCtx.statesByName[stateName.trim().toLowerCase()]
                        : undefined;
                    // Resolve pm tags -> existing Linear label ids for this team (symmetric
                    // with the importer's labels->tags mapping). Unknown tags are dropped.
                    const labelIds = resolveLabelIds(payload.labels, teamCtx.labelsByName);
                    if (payload.alreadyInLinear && payload.linearId) {
                        // Idempotent update of the linked Linear issue.
                        const input = {
                            title: payload.title,
                            description: payload.description,
                        };
                        if (stateId)
                            input.stateId = stateId;
                        if (typeof payload.priority === "number")
                            input.priority = payload.priority;
                        if (labelIds.length > 0)
                            input.labelIds = labelIds;
                        if (payload.dueDate)
                            input.dueDate = payload.dueDate;
                        applyPushDynamicFields(input, payload, teamCtx.cyclesByName);
                        const resp = await linearRequest(apiKey, ISSUE_UPDATE_MUTATION, {
                            id: payload.linearId,
                            input,
                        });
                        if (resp.errors?.length) {
                            throw new Error(`Linear issueUpdate failed: ${resp.errors.map((e) => e.message).join("; ")}`);
                        }
                        updated++;
                        continue;
                    }
                    const input = {
                        teamId: teamCtx.teamId,
                        title: payload.title,
                        description: payload.description,
                    };
                    if (stateId)
                        input.stateId = stateId;
                    if (typeof payload.priority === "number")
                        input.priority = payload.priority;
                    if (labelIds.length > 0)
                        input.labelIds = labelIds;
                    if (payload.dueDate)
                        input.dueDate = payload.dueDate;
                    applyPushDynamicFields(input, payload, teamCtx.cyclesByName);
                    const resp = await linearRequest(apiKey, ISSUE_CREATE_MUTATION, { input });
                    if (resp.errors?.length) {
                        throw new Error(`Linear issueCreate failed: ${resp.errors.map((e) => e.message).join("; ")}`);
                    }
                    created++;
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`Failed to push item ${label}: ${message}`);
                    skipped++;
                    continue;
                }
            }
            console.error(`Pushed ${created + updated} issue(s) to Linear team ${team.toUpperCase()} ` +
                `(${created} created, ${updated} updated)` +
                (skipped > 0 ? ` — ${skipped} skipped (see errors above)` : ""));
            return {
                exported: payloads.length,
                pushed: true,
                created,
                updated,
                skipped,
                team: team.toUpperCase(),
                teamSource: teamSelection.source,
            };
        });
        // -----------------------------------------------------------------------
        // Importer: linear-sync
        // -----------------------------------------------------------------------
        api.registerImporter("linear-sync", async (ctx) => {
            const teamSelection = resolveTeamSelection(ctx.options);
            if (!teamSelection) {
                throw new CommandError("linear-sync importer requires a 'team' option or LINEAR_DEFAULT_TEAM env var", EXIT_CODE.USAGE);
            }
            const team = teamSelection.team;
            if (!isJsonMode(ctx) && teamSelection.source === "env") {
                console.error(`Using LINEAR_DEFAULT_TEAM=${team.toUpperCase()} (no --team provided).`);
            }
            const limit = readNumberOption(ctx.options, "limit") ?? 100;
            const stateFilter = readStringOption(ctx.options, "state");
            const project = readStringOption(ctx.options, "project");
            const assignee = readStringOption(ctx.options, "assignee");
            const label = readStringOption(ctx.options, "label");
            const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
            const projectMap = parseProjectMap(readProjectMapOption(ctx.options));
            const result = await syncLinearIssues({ team, project, stateFilter, assignee, label, statusMap, projectMap, limit }, ctx.pm_root);
            console.error(`Synced ${result.synced} issues (${result.created} new, ${result.updated} updated) ` +
                `from Linear team ${result.team.toUpperCase()}`);
            return {
                synced: result.synced,
                created: result.created,
                updated: result.updated,
                skipped: result.skipped,
                team: result.team.toUpperCase(),
                teamSource: teamSelection.source,
            };
        });
    },
});
//# sourceMappingURL=index.js.map