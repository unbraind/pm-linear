import { spawnSync } from "node:child_process";
import https from "node:https";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

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
} as const;

class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

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

interface LinearAssignee {
  name: string | null;
  email: string | null;
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
  assignee?: LinearAssignee | null;
  url?: string | null;
}

interface LinearResponse {
  data?: {
    issues?: {
      nodes: LinearIssue[];
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
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

function camelKey(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function readStringOption(
  options: Record<string, unknown>,
  kebab: string
): string | undefined {
  const v = options[kebab] ?? options[camelKey(kebab)];
  return typeof v === "string" ? v : v === undefined ? undefined : String(v);
}

function readNumberOption(
  options: Record<string, unknown>,
  kebab: string
): number | undefined {
  const v = options[kebab] ?? options[camelKey(kebab)];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function readBooleanOption(
  options: Record<string, unknown>,
  kebab: string
): boolean {
  const v = options[kebab] ?? options[camelKey(kebab)];
  if (typeof v === "boolean") return v;
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
// --status-map parser: "Linear State=pm_status,Other State=pm_status"
// Keys are matched case-insensitively against the Linear state name and take
// precedence over the built-in mapStatus heuristic. Returns a lower-cased map.
// Pure + exported for unit testing.
// ---------------------------------------------------------------------------
export function parseStatusMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const value = pair.slice(idx + 1).trim();
    if (key && value) map[key] = value;
  }
  return map;
}

// Resolve a pm status for an issue, preferring an explicit --status-map entry
// (matched on the Linear state name) over the built-in heuristic. Pure.
export function resolveStatus(
  stateType: string,
  stateName: string,
  statusMap: Record<string, string>
): string {
  const override = statusMap[stateName.trim().toLowerCase()];
  if (override) return override;
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
const DEFAULT_PM_TO_LINEAR_STATE: Record<string, string> = {
  open: "Todo",
  in_progress: "In Progress",
  blocked: "In Progress",
  closed: "Done",
};

export function invertStatusMap(
  statusMap: Record<string, string>
): Record<string, string> {
  // statusMap is { "<linear state name lower>": "<pm status>" }; invert to
  // { "<pm status>": "<Linear state name>" }. First entry wins on collision.
  const inverted: Record<string, string> = {};
  for (const [linearName, pmStatus] of Object.entries(statusMap)) {
    const key = pmStatus.trim().toLowerCase();
    if (key && !(key in inverted)) inverted[key] = linearName;
  }
  return inverted;
}

export function resolveLinearStateName(
  pmStatus: string | undefined,
  invertedMap: Record<string, string>
): string | undefined {
  if (!pmStatus) return undefined;
  const key = pmStatus.trim().toLowerCase();
  return invertedMap[key] ?? DEFAULT_PM_TO_LINEAR_STATE[key];
}

// ---------------------------------------------------------------------------
// Provenance marker. We can't write registerItemFields custom fields via
// `pm create` from a standalone extension, so encode linear_id + linear_url in
// the item description behind a stable, machine-parseable marker. Pure.
// ---------------------------------------------------------------------------
const PROVENANCE_MARKER = "[linear]";

export function buildProvenance(issue: {
  id: string;
  identifier: string;
  url?: string | null;
}): string {
  const url = issue.url ?? `https://linear.app/issue/${issue.identifier}`;
  return `${PROVENANCE_MARKER} linear_id=${issue.id} linear_url=${url}`;
}

// Extract { linear_id, linear_url } from a pm item's description, if present.
// Returns undefined when the item has no Linear provenance. Pure + exported.
export function parseProvenance(
  description: string | undefined
): { linear_id: string; linear_url: string } | undefined {
  if (!description || !description.includes(PROVENANCE_MARKER)) return undefined;
  const idMatch = description.match(/linear_id=(\S+)/);
  const urlMatch = description.match(/linear_url=(\S+)/);
  if (!idMatch) return undefined;
  return {
    linear_id: idMatch[1],
    linear_url: urlMatch ? urlMatch[1] : "",
  };
}

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------
// Which server-side filter clauses to include. Each is omitted entirely when
// absent — a `null`/empty filter clause matches nothing rather than "any".
export interface IssueFilterFlags {
  project?: boolean;
  assignee?: boolean;
  label?: boolean;
}

// Build the issues query with only the requested filter clauses + variables.
// Pure + exported so the query-construction logic can be unit tested without
// touching the network.
export function buildIssuesQuery(flags: IssueFilterFlags): string {
  const clauses: string[] = ["team: { key: { eq: $team } }"];
  const vars: string[] = ["$team: String!", "$first: Int!", "$after: String"];
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
      state { name type }
      labels { nodes { name } }
      assignee { name email }
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
interface FetchFilters {
  project?: string;
  assignee?: string;
  label?: string;
}

async function fetchAllLinearIssues(
  apiKey: string,
  team: string,
  limit: number,
  filters: FetchFilters = {}
): Promise<LinearIssue[]> {
  const all: LinearIssue[] = [];
  let after: string | null = null;
  const project = filters.project?.trim();
  const assignee = filters.assignee?.trim();
  const label = filters.label?.trim();
  const flags: IssueFilterFlags = {
    project: Boolean(project),
    assignee: Boolean(assignee),
    label: Boolean(label),
  };
  const query = buildIssuesQuery(flags);

  while (all.length < limit) {
    const remaining = limit - all.length;
    const first = Math.min(remaining, LINEAR_MAX_PAGE_SIZE);

    const variables: Record<string, unknown> = {
      team: team.toUpperCase(),
      first,
      after,
    };
    if (flags.project) variables.project = project;
    if (flags.assignee) variables.assignee = assignee;
    if (flags.label) variables.label = label;

    const response: LinearResponse = await linearRequest(apiKey, query, variables);

    if (response.errors?.length) {
      const msgs = response.errors.map((e) => e.message).join("; ");
      throw new CommandError(`Linear API error: ${msgs}`);
    }

    const page = response.data?.issues;
    const nodes = page?.nodes ?? [];
    all.push(...nodes);

    const info = page?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor || nodes.length === 0) break;
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
  status: number;
  retryAfterMs?: number;
  constructor(status: number, retryAfterMs?: number) {
    super(`Linear API returned retriable HTTP ${status}`);
    this.name = "RetriableHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// Compute the delay before the next attempt. Pure + exported for testing.
// `attempt` is zero-based (0 = first retry). Honors an explicit Retry-After.
export function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === "number" && retryAfterMs >= 0) return retryAfterMs;
  // 250ms, 500ms, 1s, 2s … capped at 8s.
  return Math.min(250 * 2 ** attempt, 8_000);
}

function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (!header) return undefined;
  const raw = Array.isArray(header) ? header[0] : header;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function linearRequestOnce(
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
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: apiKey,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (status === 429 || (status >= 500 && status <= 599)) {
            res.resume();
            reject(
              new RetriableHttpError(status, parseRetryAfter(res.headers["retry-after"]))
            );
            return;
          }
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            resolve(JSON.parse(raw) as LinearResponse);
          } catch (err) {
            reject(new Error(`Failed to parse Linear response: ${String(err)}`));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new RetriableHttpError(0));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function linearRequest(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<LinearResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await linearRequestOnce(apiKey, query, variables);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof RetriableHttpError) || attempt === MAX_RETRIES) break;
      await sleep(backoffDelayMs(attempt, err.retryAfterMs));
    }
  }
  const msg =
    lastErr instanceof RetriableHttpError
      ? `Linear API unavailable after ${MAX_RETRIES + 1} attempts (HTTP ${lastErr.status || "timeout"})`
      : `Linear request failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`;
  throw new CommandError(msg);
}

// ---------------------------------------------------------------------------
// pm item shape (subset of `pm list --json`) + reader
// ---------------------------------------------------------------------------
interface PmItem {
  id?: string;
  title?: string;
  status?: string;
  body?: string;
  description?: string;
  priority?: number;
  tags?: string[];
}

const PM_LIST_MAX_BUFFER = 16 * 1024 * 1024;

function readPmItems(pmRoot: string): PmItem[] {
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "--json", "list", "--full", "--include-body", "--limit", "10000"],
    { encoding: "utf-8", maxBuffer: PM_LIST_MAX_BUFFER }
  );
  if (result.error) {
    throw new CommandError(`pm list failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CommandError(result.stderr || "pm list failed");
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
    return items as PmItem[];
  } catch {
    throw new CommandError("Could not parse `pm list --json` output.");
  }
}

// ---------------------------------------------------------------------------
// Core sync logic — shared between command and importer
// ---------------------------------------------------------------------------
interface SyncOptions {
  team: string;
  stateFilter?: string;
  project?: string;
  assignee?: string;
  label?: string;
  statusMap?: Record<string, string>;
  limit: number;
  dryRun?: boolean;
}

interface SyncResult {
  synced: number;
  created: number;
  updated: number;
  skipped: number;
  team: string;
  issues: LinearIssue[];
}

// Index existing pm items by their stored Linear id (parsed from the provenance
// marker) so a re-import can UPDATE the matching item instead of creating a
// duplicate. Items without Linear provenance are ignored. Pure + exported.
export function indexItemsByLinearId(
  items: PmItem[]
): Record<string, PmItem> {
  const index: Record<string, PmItem> = {};
  for (const item of items) {
    const prov = parseProvenance(item.description);
    if (prov?.linear_id) index[prov.linear_id] = item;
  }
  return index;
}

async function syncLinearIssues(
  options: SyncOptions,
  pm_root: string
): Promise<SyncResult> {
  const apiKey = process.env["LINEAR_API_KEY"];
  if (!apiKey) {
    throw new CommandError(
      "LINEAR_API_KEY environment variable is not set. " +
        "Get your API key at https://linear.app/settings/api",
      EXIT_CODE.USAGE
    );
  }

  const scopeBits: string[] = [];
  if (options.project) scopeBits.push(`project "${options.project}"`);
  if (options.assignee) scopeBits.push(`assignee ${options.assignee}`);
  if (options.label) scopeBits.push(`label "${options.label}"`);
  const scope = scopeBits.length ? ` (${scopeBits.join(", ")})` : "";
  console.error(`Fetching issues from Linear team: ${options.team}${scope} (limit: ${options.limit})`);

  const issues = await fetchAllLinearIssues(apiKey, options.team, options.limit, {
    project: options.project,
    assignee: options.assignee,
    label: options.label,
  });

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
    // Optional state name filter (applied client-side after fetch)
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
    // what re-import + `pm linear export` read back to stay idempotent.
    const description = buildProvenance(issue);
    const existing = existingByLinearId[issue.id];

    if (options.dryRun) {
      const verb = existing ? "update" : "create";
      console.error(
        `[dry-run] Would ${verb}: ${issue.identifier} — ${issue.title} (${status}, p${priority})`
      );
      if (existing) updated++;
      else created++;
      continue;
    }

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
      if (body) updateArgs.push("--body", body);
      if (tags.length > 0) updateArgs.push("--tags", tags.join(","));
      if (issue.dueDate) updateArgs.push("--deadline", issue.dueDate);

      const result = spawnSync("pm", updateArgs, { encoding: "utf-8" });
      if (result.status !== 0) {
        console.error(`Failed to update item for ${issue.identifier}: ${result.stderr}`);
        skipped++;
        continue;
      }
      updated++;
    } else {
      const createArgs = [
        "--path", pm_root,
        "create",
        "--title", title,
        "--status", status,
        "--priority", String(priority),
        "--description", description,
      ];
      if (body) createArgs.push("--body", body);
      if (tags.length > 0) createArgs.push("--tags", tags.join(","));
      if (issue.dueDate) createArgs.push("--deadline", issue.dueDate);

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

// ---------------------------------------------------------------------------
// Export core — render pm items as Linear issue payloads
// ---------------------------------------------------------------------------
// Linear issueCreate/issueUpdate input. teamId is required by the API for a
// real create, so callers must supply --team and we resolve it to an id at
// push time. For updates we instead address the existing issue by linearId.
interface LinearCreatePayload {
  title: string;
  description: string;
  // pm provenance carried through so a re-import is idempotent.
  pmId?: string;
  pmStatus?: string;
  alreadyInLinear: boolean;
  linearId?: string;
  linearUrl?: string;
}

// Pure transform: pm item -> Linear issue payload. Items that already carry
// Linear provenance are flagged (and keep their linear id) so `--push` UPDATES
// them in place instead of creating a duplicate.
export function itemToLinearPayload(item: PmItem): LinearCreatePayload {
  const provenance = parseProvenance(item.description);
  return {
    title: item.title ?? "(untitled)",
    description: item.body || (provenance ? "" : item.description || ""),
    pmId: item.id,
    pmStatus: item.status,
    alreadyInLinear: provenance !== undefined,
    linearId: provenance?.linear_id || undefined,
    linearUrl: provenance?.linear_url || undefined,
  };
}

// Resolve a Linear team key (e.g. "ENG") to its internal id for issueCreate,
// and fetch its workflow states so the exporter can map pm status -> a real
// state id when pushing. One round-trip.
const TEAM_QUERY = `
query($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes { id states { nodes { id name } } }
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

interface TeamContext {
  teamId: string;
  // Linear state name (lower-cased) -> state id, for status push.
  statesByName: Record<string, string>;
}

async function resolveTeamContext(apiKey: string, teamKey: string): Promise<TeamContext> {
  const resp: any = await linearRequest(apiKey, TEAM_QUERY, { key: teamKey.toUpperCase() });
  if (resp.errors?.length) {
    throw new CommandError(
      `Linear API error resolving team ${teamKey}: ${resp.errors.map((e: any) => e.message).join("; ")}`
    );
  }
  const node = resp.data?.teams?.nodes?.[0];
  if (!node?.id) {
    throw new CommandError(`Linear team "${teamKey}" not found.`, EXIT_CODE.NOT_FOUND);
  }
  const statesByName: Record<string, string> = {};
  for (const s of node.states?.nodes ?? []) {
    if (s?.name && s?.id) statesByName[String(s.name).trim().toLowerCase()] = s.id;
  }
  return { teamId: node.id, statesByName };
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
function commandMutatesLinear(command: string, options: Record<string, unknown>): boolean {
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
async function preflightLinear(
  options: Record<string, unknown>,
  checkReachability: boolean
): Promise<string | null> {
  const apiKey = process.env["LINEAR_API_KEY"];
  if (!apiKey) {
    return (
      "LINEAR_API_KEY is not set. Linear operations that write data require an " +
      "API key. Get one at https://linear.app/settings/api and `export LINEAR_API_KEY=...`."
    );
  }
  if (!checkReachability) return null;
  try {
    const resp: any = await linearRequest(apiKey, "query { viewer { id } }", {});
    if (resp.errors?.length) {
      return `Linear API rejected the credentials: ${resp.errors.map((e: any) => e.message).join("; ")}`;
    }
    if (!resp.data?.viewer?.id) {
      return "Linear API reachable but returned no viewer; check the API key scope.";
    }
    return null;
  } catch (err) {
    return `Linear API unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Read + clear the sentinel a preflight may have injected; throw if present.
function assertPreflightOk(options: Record<string, unknown>): void {
  const err = options[PREFLIGHT_ERROR_OPTION];
  if (typeof err === "string" && err) {
    throw new CommandError(err, EXIT_CODE.USAGE);
  }
}

// ---------------------------------------------------------------------------
// Extension definition
// ---------------------------------------------------------------------------
export default defineExtension({
  name: "pm-linear",
  version: "2026.6.2",

  activate(api) {
    // -----------------------------------------------------------------------
    // preflight — validate credentials + reachability before any mutating
    // Linear command runs. On failure it injects a sentinel option (it cannot
    // abort by throwing) that the handlers convert into a clean USAGE error.
    // -----------------------------------------------------------------------
    api.registerPreflight(async (ctx: any) => {
      if (!commandMutatesLinear(ctx.command, ctx.options)) return {};
      // Reachability uses the network; allow opting out (CI/offline/tests).
      const checkReachability =
        !readBooleanOption(ctx.options, "no-preflight-network") &&
        process.env["LINEAR_PREFLIGHT_NO_NETWORK"] !== "1";
      const error = await preflightLinear(ctx.options, checkReachability);
      if (!error) return {};
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
        "pm linear sync --team ENG --state 'In Progress'",
        "pm linear sync --team ENG --assignee dev@acme.com --label bug",
        "pm linear sync --team ENG --limit 50",
        "pm linear sync --team ENG --dry-run",
      ],
      flags: [
        { long: "--team", value_name: "slug", description: "Linear team slug (e.g. ENG, BACKEND). Required." },
        { long: "--project", value_name: "name", description: "Filter by Linear project name. Optional." },
        { long: "--state", value_name: "name", description: "Filter by Linear state name (e.g. 'In Progress', 'Todo'). Optional." },
        { long: "--assignee", value_name: "email", description: "Filter by assignee email. Optional." },
        { long: "--label", value_name: "name", description: "Filter by label name. Optional." },
        { long: "--status-map", value_name: "map", description: "Override status mapping, e.g. \"In Review=in_progress,Backlog=open\". Optional." },
        { long: "--limit", value_name: "n", description: "Maximum number of issues to fetch (default: 100)" },
        { long: "--dry-run", description: "Preview what would be synced without writing anything" },
      ],

      async run(ctx) {
        assertPreflightOk(ctx.options);
        const team = readStringOption(ctx.options, "team");
        const project = readStringOption(ctx.options, "project");
        const stateFilter = readStringOption(ctx.options, "state");
        const assignee = readStringOption(ctx.options, "assignee");
        const label = readStringOption(ctx.options, "label");
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
          const result = await syncLinearIssues(
            { team, project, stateFilter, assignee, label, statusMap, limit, dryRun },
            ctx.pm_root
          );

          const verb = dryRun ? "Would sync" : "Synced";
          const summary =
            `${verb} ${result.synced} issue${result.synced !== 1 ? "s" : ""} ` +
            `(${result.created} new, ${result.updated} updated) from Linear team ${result.team.toUpperCase()}`;
          if (result.skipped > 0) {
            console.error(`${summary} (${result.skipped} skipped)`);
          } else {
            console.error(summary);
          }

          return {
            success: true,
            synced: result.synced,
            created: result.created,
            updated: result.updated,
            skipped: result.skipped,
            team: result.team.toUpperCase(),
            dryRun,
          };
        } catch (err: unknown) {
          // Preserve a more specific exitCode (e.g. a missing API key is a
          // USAGE error) rather than flattening everything to a generic failure.
          if (err instanceof CommandError) throw err;
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

    // Surface importer/exporter flags in help. The importer/exporter read these
    // off ctx.options regardless, but declaring them makes `pm linear import
    // --help` / `pm linear export --help` self-documenting.
    api.registerFlags("linear import", [
      { long: "--team", value_name: "slug", description: "Linear team slug (or set LINEAR_DEFAULT_TEAM)." },
      { long: "--project", value_name: "name", description: "Filter by Linear project name." },
      { long: "--state", value_name: "name", description: "Filter by Linear state name." },
      { long: "--assignee", value_name: "email", description: "Filter by assignee email." },
      { long: "--label", value_name: "name", description: "Filter by label name." },
      { long: "--status-map", value_name: "map", description: "Override status mapping, e.g. \"In Review=in_progress\"." },
      { long: "--limit", value_name: "n", description: "Maximum number of issues to fetch (default: 100)." },
      { long: "--dry-run", description: "Preview without writing (reports create vs update)." },
    ]);
    api.registerFlags("linear export", [
      { long: "--push", description: "Create/update the issues in Linear (requires LINEAR_API_KEY + --team)." },
      { long: "--team", value_name: "slug", description: "Target Linear team slug (required with --push)." },
      { long: "--status-map", value_name: "map", description: "pm-status<->Linear-state map; inverted for the push direction." },
      { long: "--dry-run", description: "With --push, preview the create/update plan without mutating Linear." },
    ]);

    // -----------------------------------------------------------------------
    // importer — `pm linear import` (native import pipeline; pulls issues via
    // the Linear GraphQL API and creates pm items, reusing the sync core).
    // -----------------------------------------------------------------------
    api.registerImporter("linear", async (ctx) => {
      assertPreflightOk(ctx.options);
      const team =
        readStringOption(ctx.options, "team") ?? process.env["LINEAR_DEFAULT_TEAM"];
      if (!team) {
        throw new CommandError(
          "pm linear import requires --team <slug> (or set LINEAR_DEFAULT_TEAM). " +
            "Example: pm linear import --team ENG",
          EXIT_CODE.USAGE
        );
      }
      const project = readStringOption(ctx.options, "project");
      const stateFilter = readStringOption(ctx.options, "state");
      const assignee = readStringOption(ctx.options, "assignee");
      const label = readStringOption(ctx.options, "label");
      const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
      const limit = readNumberOption(ctx.options, "limit") ?? 100;
      const dryRun = readBooleanOption(ctx.options, "dry-run");

      try {
        const result = await syncLinearIssues(
          { team, project, stateFilter, assignee, label, statusMap, limit, dryRun },
          ctx.pm_root
        );
        console.error(
          `Imported ${result.synced} issue(s) (${result.created} new, ${result.updated} updated) ` +
            `from Linear team ${result.team.toUpperCase()}` +
            (result.skipped > 0 ? ` (${result.skipped} skipped)` : "")
        );
        return {
          imported: result.synced,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          team: result.team.toUpperCase(),
          dryRun,
        };
      } catch (err: unknown) {
        if (err instanceof CommandError) throw err;
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
      const invertedStatusMap = invertStatusMap(
        parseStatusMap(readStringOption(ctx.options, "status-map"))
      );
      const items = readPmItems(ctx.pm_root);
      const payloads = items.map(itemToLinearPayload);

      // Default + dry-run: print payloads with the planned create/update action.
      if (!push || dryRun) {
        const printable = payloads.map((p) => ({
          action: p.alreadyInLinear ? "update" : "create",
          title: p.title,
          description: p.description,
          targetState: resolveLinearStateName(p.pmStatus, invertedStatusMap) ?? null,
          ...(p.linearId ? { linearId: p.linearId } : {}),
          ...(p.linearUrl ? { linearUrl: p.linearUrl } : {}),
        }));
        console.log(JSON.stringify(printable, null, 2));
        const wouldCreate = printable.filter((p) => p.action === "create").length;
        const wouldUpdate = printable.length - wouldCreate;
        if (dryRun && push) {
          console.error(
            `[dry-run] Would push ${printable.length} item(s): ${wouldCreate} create, ${wouldUpdate} update.`
          );
        }
        return {
          exported: printable.length,
          pushed: false,
          dryRun: dryRun && push,
          wouldCreate,
          wouldUpdate,
        };
      }

      // Real push. Preflight has already validated the key + reachability; the
      // explicit checks below keep the contract self-evident at the call site.
      const apiKey = process.env["LINEAR_API_KEY"];
      if (!apiKey) {
        throw new CommandError(
          "--push requires LINEAR_API_KEY. Get a key at https://linear.app/settings/api",
          EXIT_CODE.USAGE
        );
      }
      const team =
        readStringOption(ctx.options, "team") ?? process.env["LINEAR_DEFAULT_TEAM"];
      if (!team) {
        throw new CommandError(
          "--push requires --team <slug> to create issues in Linear.",
          EXIT_CODE.USAGE
        );
      }

      const teamCtx = await resolveTeamContext(apiKey, team);
      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const payload of payloads) {
        // Map pm status -> a concrete Linear workflow-state id for this team,
        // when one resolves; otherwise leave the state untouched.
        const stateName = resolveLinearStateName(payload.pmStatus, invertedStatusMap);
        const stateId = stateName
          ? teamCtx.statesByName[stateName.trim().toLowerCase()]
          : undefined;

        if (payload.alreadyInLinear && payload.linearId) {
          // Idempotent update of the linked Linear issue.
          const input: Record<string, unknown> = {
            title: payload.title,
            description: payload.description,
          };
          if (stateId) input.stateId = stateId;
          const resp: any = await linearRequest(apiKey, ISSUE_UPDATE_MUTATION, {
            id: payload.linearId,
            input,
          });
          if (resp.errors?.length) {
            throw new CommandError(
              `Linear issueUpdate failed: ${resp.errors.map((e: any) => e.message).join("; ")}`
            );
          }
          updated++;
          continue;
        }

        const input: Record<string, unknown> = {
          teamId: teamCtx.teamId,
          title: payload.title,
          description: payload.description,
        };
        if (stateId) input.stateId = stateId;
        const resp: any = await linearRequest(apiKey, ISSUE_CREATE_MUTATION, { input });
        if (resp.errors?.length) {
          throw new CommandError(
            `Linear issueCreate failed: ${resp.errors.map((e: any) => e.message).join("; ")}`
          );
        }
        created++;
      }
      console.error(
        `Pushed ${created + updated} issue(s) to Linear team ${team.toUpperCase()} ` +
          `(${created} created, ${updated} updated)` +
          (skipped > 0 ? ` — ${skipped} skipped` : "")
      );
      return { exported: payloads.length, pushed: true, created, updated, skipped };
    });

    // -----------------------------------------------------------------------
    // Importer: linear-sync
    // -----------------------------------------------------------------------
    api.registerImporter("linear-sync", async (ctx) => {
      const team =
        readStringOption(ctx.options, "team") ??
        process.env["LINEAR_DEFAULT_TEAM"];

      if (!team) {
        throw new CommandError(
          "linear-sync importer requires a 'team' option or LINEAR_DEFAULT_TEAM env var",
          EXIT_CODE.USAGE
        );
      }

      const limit = readNumberOption(ctx.options, "limit") ?? 100;
      const stateFilter = readStringOption(ctx.options, "state");
      const project = readStringOption(ctx.options, "project");
      const assignee = readStringOption(ctx.options, "assignee");
      const label = readStringOption(ctx.options, "label");
      const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));

      const result = await syncLinearIssues(
        { team, project, stateFilter, assignee, label, statusMap, limit },
        ctx.pm_root
      );

      console.error(
        `Synced ${result.synced} issues (${result.created} new, ${result.updated} updated) ` +
          `from Linear team ${result.team.toUpperCase()}`
      );

      return {
        synced: result.synced,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        team: result.team.toUpperCase(),
      };
    });
  },
});
