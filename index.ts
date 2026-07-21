import { spawnSync } from "node:child_process";
import https from "node:https";
import crypto from "node:crypto";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";
import type {
  BulkItemMutation,
  CommitItemMutationsOptions,
  CommitItemMutationsResult,
} from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
export const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

export class CommandError extends Error {
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

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  estimate?: number | null;
  state: LinearState;
  labels: { nodes: LinearLabel[] };
  dueDate: string | null;
  cycle: LinearCycle | null;
  assignee?: LinearAssignee | null;
  project?: { name: string } | null;
  customer?: { name: string } | null;
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

// Read --project-map, preserving the "absent vs bare-flag" distinction that a
// plain readStringOption would lose. Returns undefined when the flag was not
// passed at all; "" (passthrough) when passed as a bare boolean flag; otherwise
// the string value. This lets `--project-map` (no value) mean "tag with the
// verbatim project name" while still supporting `--project-map "A=x,B=y"`.
function readProjectMapOption(options: Record<string, unknown>): string | undefined {
  const v = options["project-map"] ?? options[camelKey("project-map")];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v ? "" : undefined;
  return typeof v === "string" ? v : String(v);
}

type TeamSource = "flag" | "env";

export interface TeamSelection {
  team: string;
  source: TeamSource;
}

function normalizeTeam(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeCycleFilter(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

// Resolve the Linear team from --team first, then LINEAR_DEFAULT_TEAM. The
// source is returned so human + JSON output can explain where the team came
// from (important for automation/debugging when defaults are injected).
export function resolveTeamSelection(
  options: Record<string, unknown>,
  envDefaultTeam: string | undefined = process.env["LINEAR_DEFAULT_TEAM"]
): TeamSelection | undefined {
  const fromFlag = normalizeTeam(readStringOption(options, "team"));
  if (fromFlag) return { team: fromFlag, source: "flag" };
  const fromEnv = normalizeTeam(envDefaultTeam);
  if (fromEnv) return { team: fromEnv, source: "env" };
  return undefined;
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
// pm priority → Linear priority (reverse of mapPriority, for export).
// pm:     1=Urgent, 2=High, 3=Medium, 4=Low (and we treat anything else as 0).
// Linear: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low.
// pm 1..4 maps 1:1 onto Linear 1..4; any other value (undefined/0/out-of-range)
// becomes Linear 0 ("No priority") so we never push a bogus int. Pure + exported.
// ---------------------------------------------------------------------------
export function mapPriorityToLinear(pmPriority: number | undefined): number {
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
export function normalizeDueDate(deadline: string | undefined): string | undefined {
  if (!deadline) return undefined;
  const trimmed = deadline.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
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
// precedence over the built-in mapStatus heuristic. The map PRESERVES the
// original key casing (e.g. "In Review", "Backlog") so the export-preview /
// inverted direction can echo the Linear state name as the user typed it;
// matching is done case-insensitively in resolveStatus + lookupStatusOverride.
// Pure + exported for unit testing.
// ---------------------------------------------------------------------------
export function parseStatusMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    // Last writer wins on a case-insensitive key collision; we keep the most
    // recent original-case spelling so the map never silently merges entries.
    if (key && value) {
      const existing = Object.keys(map).find(
        (k) => k.toLowerCase() === key.toLowerCase()
      );
      if (existing) delete map[existing];
      map[key] = value;
    }
  }
  return map;
}

// Case-insensitive lookup of the pm status mapped to a Linear state name, using
// a status map whose keys retain their original casing. Pure.
function lookupStatusOverride(
  statusMap: Record<string, string>,
  stateName: string
): string | undefined {
  const needle = stateName.trim().toLowerCase();
  for (const [key, value] of Object.entries(statusMap)) {
    if (key.trim().toLowerCase() === needle) return value;
  }
  return undefined;
}

// Resolve a pm status for an issue, preferring an explicit --status-map entry
// (matched case-insensitively on the Linear state name) over the built-in
// heuristic. Pure.
export function resolveStatus(
  stateType: string,
  stateName: string,
  statusMap: Record<string, string>
): string {
  const override = lookupStatusOverride(statusMap, stateName);
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
  // statusMap is { "<Linear state name, original casing>": "<pm status>" };
  // invert to { "<pm status>": "<Linear state name, original casing>" }. The
  // original casing is preserved so the export preview / push target echoes the
  // state name exactly as the user typed it (e.g. "Backlog", not "backlog").
  // First entry wins on collision.
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
// --project-map: tag imported items by their Linear project name, analogous to
// --status-map. The flag is ADDITIVE — items keep their label-derived tags and
// gain one more tag for their project.
//
// Two modes, both off unless --project-map is supplied:
//   --project-map                 (no value / "*" / "true")
//       passthrough: tag each item with its own Linear project name verbatim.
//   --project-map "Mobile=mobile,Web=web"
//       explicit remap: a project whose name matches (case-insensitively) a key
//       is tagged with the mapped value; an unmatched project falls back to its
//       own name (so partial maps still tag everything). A mapped value of
//       "ignore" suppresses tagging for that project.
//
// parseProjectMap returns { passthrough, map }. Pure + exported for testing.
// ---------------------------------------------------------------------------
export interface ProjectMap {
  enabled: boolean;
  passthrough: boolean;
  map: Record<string, string>;
}

export function parseProjectMap(raw: string | undefined): ProjectMap {
  if (raw === undefined) return { enabled: false, passthrough: false, map: {} };
  const trimmed = raw.trim();
  // Bare flag / "*" / "true" => passthrough (tag with the verbatim project name).
  if (trimmed === "" || trimmed === "*" || trimmed.toLowerCase() === "true") {
    return { enabled: true, passthrough: true, map: {} };
  }
  const map: Record<string, string> = {};
  let sawPair = false;
  for (const pair of trimmed.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
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
export function resolveProjectTag(
  projectName: string | null | undefined,
  projectMap: ProjectMap
): string | undefined {
  if (!projectMap.enabled) return undefined;
  const name = projectName?.trim();
  if (!name) return undefined;
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
] as const;

export function parseFieldMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const value = pair.slice(idx + 1).trim().toLowerCase();
    if (key && value) map[key] = value;
  }
  return map;
}

// True when the Linear field is suppressed via `--map <field>=ignore`. Pure.
export function fieldIsIgnored(
  fieldMap: Record<string, string>,
  linearField: string
): boolean {
  return fieldMap[linearField.toLowerCase()] === "ignore";
}

// Resolve the pm target field for a given Linear field, honoring an override.
// Returns the override (unless "ignore"), else the Linear field name itself.
// Pure + exported for testing.
export function resolvePmField(
  fieldMap: Record<string, string>,
  linearField: string
): string {
  const override = fieldMap[linearField.toLowerCase()];
  if (!override || override === "ignore") return linearField.toLowerCase();
  return override;
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
  updatedSince?: boolean;
  state?: boolean;
  // Linear cycle name. Filtered server-side via the
  // `cycle: { name: { containsIgnoreCase: $cycle } }` GraphQL clause (Linear's
  // CycleFilter exposes `name: StringComparator`) so `--limit` + `--cycle` does
  // not under-return on teams whose matching issues page beyond the fetched
  // window. A null cycle never matches, which is the desired semantic (a cycle
  // filter selects issues IN that cycle).
  cycle?: boolean;
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
  if (flags.cycle) {
    // Linear's CycleFilter exposes `name: StringComparator`; a case-insensitive
    // substring match mirrors --state. Issues with no cycle (cycle == null) do
    // not match, which is the intended semantic for a cycle filter.
    clauses.push("cycle: { name: { containsIgnoreCase: $cycle } }");
    vars.push("$cycle: String!");
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

// ---------------------------------------------------------------------------
// Build the exact GraphQL request (query + variables) an import WOULD send,
// without touching the network. Used by --dry-run so the preview is the literal
// request, and by fetchAllLinearIssues so there is a single source of truth.
// `apiKeyPresent` only controls whether we annotate the plan; no key is read.
// Pure + exported for unit testing.
// ---------------------------------------------------------------------------
export interface ImportRequestPlan {
  endpoint: string;
  method: "POST";
  query: string;
  variables: Record<string, unknown>;
}

export function buildImportRequestPlan(
  team: string,
  limit: number,
  filters: FetchFilters = {},
  after: string | null = null
): ImportRequestPlan {
  const project = filters.project?.trim();
  const assignee = filters.assignee?.trim();
  const label = filters.label?.trim();
  const updatedSince = filters.updatedSince?.trim();
  const state = filters.state?.trim();
  const cycle = filters.cycle?.trim();
  const flags: IssueFilterFlags = {
    project: Boolean(project),
    assignee: Boolean(assignee),
    label: Boolean(label),
    updatedSince: Boolean(updatedSince),
    state: Boolean(state),
    cycle: Boolean(cycle),
  };
  const variables: Record<string, unknown> = {
    team: team.toUpperCase(),
    first: Math.min(Math.max(limit, 1), LINEAR_MAX_PAGE_SIZE),
    after,
  };
  if (flags.project) variables.project = project;
  if (flags.assignee) variables.assignee = assignee;
  if (flags.label) variables.label = label;
  if (flags.updatedSince) variables.updatedSince = updatedSince;
  if (flags.state) variables.state = state;
  if (flags.cycle) variables.cycle = cycle;
  return {
    endpoint: "https://api.linear.app/graphql",
    method: "POST",
    query: buildIssuesQuery(flags),
    variables,
  };
}

// ---------------------------------------------------------------------------
// Fetch all issues for a team, following GraphQL cursor pagination up to limit.
// ---------------------------------------------------------------------------
interface FetchFilters {
  project?: string;
  assignee?: string;
  label?: string;
  updatedSince?: string;
  // Linear workflow-state name. Filtered server-side via the
  // `state: { name: { eq: $state } }` GraphQL clause so `--limit` + `--state`
  // does not under-return on large teams (a client-side filter applied AFTER
  // fetching `limit` issues would drop matches that live beyond the page).
  state?: string;
  // Linear cycle name. Filtered server-side via the
  // `cycle: { name: { containsIgnoreCase: $cycle } }` GraphQL clause (mirrors
  // `state`) so `--limit` + `--cycle` bounds the MATCHING issues rather than
  // the pre-filter page.
  cycle?: string;
}

async function fetchAllLinearIssues(
  apiKey: string,
  team: string,
  limit: number,
  filters: FetchFilters = {}
): Promise<LinearIssue[]> {
  const all: LinearIssue[] = [];
  let after: string | null = null;

  while (all.length < limit) {
    const remaining = limit - all.length;
    // buildImportRequestPlan is the single source of truth for query+variables;
    // it caps `first` at the page size. Pass `remaining` so the last page does
    // not over-fetch.
    const plan = buildImportRequestPlan(team, remaining, filters, after);
    const response: LinearResponse = await linearRequest(
      apiKey,
      plan.query,
      plan.variables
    );

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

// Non-retriable authentication/authorization failure (HTTP 401/403). Surfaced as
// a distinct type so linearRequest can map it to a clear, actionable CommandError
// (with a USAGE exit code) instead of the generic "Linear request failed"
// wrapping or the GraphQL-errors path that 401s never reach (Linear returns 401
// at the HTTP layer, so the body is never parsed as a GraphQL response).
export class AuthHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`Linear API rejected credentials (HTTP ${status})`);
    this.name = "AuthHttpError";
    this.status = status;
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
            reject(
              new RetriableHttpError(status, parseRetryAfter(res.headers["retry-after"]))
            );
            return;
          }
          // 401/403 are permanent auth failures, not transient — never retry.
          // Linear returns these at the HTTP layer (the body is an error JSON,
          // not a GraphQL response), so surface a typed error that linearRequest
          // converts into a clear, actionable message rather than a confusing
          // "Failed to parse Linear response" / generic wrap.
          if (status === 401 || status === 403) {
            reject(new AuthHttpError(status));
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
  // A permanent auth failure (HTTP 401/403) gets a clear, actionable message
  // with a USAGE exit code — "the key is bad/expired/missing scope, fix it" —
  // rather than the generic "Linear request failed" wrap. AuthHttpError is not
  // retriable, so the loop broke on the first attempt.
  if (lastErr instanceof AuthHttpError) {
    throw new CommandError(
      `Linear API rejected the API key (HTTP ${lastErr.status}). ` +
        `LINEAR_API_KEY is missing, invalid, expired, or lacks permission for this ` +
        `operation. Get a fresh key at https://linear.app/settings/api, then ` +
        `re-export LINEAR_API_KEY and retry.`,
      EXIT_CODE.USAGE
    );
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
  // pm stores deadlines as a full ISO datetime; exported as Linear `dueDate`.
  deadline?: string;
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
  cycleFilter?: string;
  project?: string;
  assignee?: string;
  label?: string;
  updatedSince?: string;
  statusMap?: Record<string, string>;
  fieldMap?: Record<string, string>;
  projectMap?: ProjectMap;
  limit: number;
  dryRun?: boolean;
  /** Commit the whole batch as one crash-resumable transaction (pm-cli >=2026.7.20). */
  atomic?: boolean;
}

/** Test seams for {@link syncLinearIssues}; each defaults to the live path. */
export interface SyncRunDependencies {
  /** Inject the Linear fetch (offline tests). */
  fetchIssues?: (
    apiKey: string,
    team: string,
    limit: number,
    filters: FetchFilters,
  ) => Promise<LinearIssue[]>;
  /** Inject the local pm item read. */
  readItems?: (pmRoot: string) => PmItem[];
  /** Inject the atomic commit (offline/dry-run tests). */
  commitAtomic?: typeof importLinearAtomic;
}

interface SyncResult {
  synced: number;
  created: number;
  updated: number;
  skipped: number;
  team: string;
  issues: LinearIssue[];
  // Atomic-only fields. Present when the batch committed as one transaction
  // (or, for dryRun, when --atomic --dry-run shared the atomic prep path).
  atomic?: boolean;
  dryRun?: boolean;
  transactionId?: string;
  recovered?: boolean;
  recoveredItems?: number;
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

// Resolved pm fields for one Linear issue, honoring --status-map and --map.
// Pure + exported so the full Linear->pm field mapping is unit-testable in both
// the real-write and dry-run paths (they share this single builder).
export interface ItemPlan {
  title: string;
  body: string;
  status: string;
  priority: number;
  tags: string[];
  deadline?: string;
  description: string; // provenance marker
  // Linear assignee.email (preferred) or .name, written to the pm item via
  // `pm create/update --assignee`. Omitted when the issue is unassigned or the
  // `assignee` field is suppressed via --map assignee=ignore.
  assignee?: string;
}

export function buildItemPlan(
  issue: LinearIssue,
  statusMap: Record<string, string>,
  fieldMap: Record<string, string> = {},
  projectMap: ProjectMap = { enabled: false, passthrough: false, map: {} }
): ItemPlan {
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
  if (projectTag && !tags.includes(projectTag)) tags.push(projectTag);
  // Linear cycle -> a `cycle:<name>` tag. pm has no first-class cycle/sprint
  // field reachable from a standalone extension's `pm create`, so we encode the
  // cycle as a namespaced tag (de-duplicated, additive alongside labels). This
  // keeps the cycle queryable (`pm list --tag "cycle:..."`) without a custom
  // field setter. Suppressed when --map labels=ignore drops tags entirely.
  const cycleName = issue.cycle?.name?.trim();
  if (cycleName && !fieldIsIgnored(fieldMap, "labels")) {
    const cycleTag = `cycle:${cycleName}`;
    if (!tags.includes(cycleTag)) tags.push(cycleTag);
  }
  if (typeof issue.estimate === "number" && !fieldIsIgnored(fieldMap, "estimate")) {
    const estimateTag = `estimate:${issue.estimate}`;
    if (!tags.includes(estimateTag)) tags.push(estimateTag);
  }
  const customerName = issue.customer?.name?.trim();
  if (customerName && !fieldIsIgnored(fieldMap, "customer")) {
    const customerTag = `customer:${customerName}`;
    if (!tags.includes(customerTag)) tags.push(customerTag);
  }
  const plan: ItemPlan = {
    title,
    body,
    status,
    priority,
    tags,
    description: buildProvenance(issue),
  };
  if (issue.dueDate) plan.deadline = issue.dueDate;
  // Linear assignee -> pm --assignee (email preferred, else display name).
  // Honors --map assignee=ignore.
  if (!fieldIsIgnored(fieldMap, "assignee")) {
    const assignee = issue.assignee?.email?.trim() || issue.assignee?.name?.trim();
    if (assignee) plan.assignee = assignee;
  }
  return plan;
}

// Build the OFFLINE dry-run plan for an import: the literal GraphQL request that
// WOULD be sent (no network) plus a count of existing Linear-linked pm items the
// import would reconcile against (read-only, local). Pure aside from the local
// pm read; exported helper buildImportRequestPlan is the network-shaped piece.
interface ImportDryRunPlan {
  dryRun: true;
  team: string;
  request: ImportRequestPlan;
  existingLinkedItems: number;
  fieldMap: Record<string, string>;
  statusMap: Record<string, string>;
  projectMap: ProjectMap;
}

function buildImportDryRunPlan(
  options: SyncOptions,
  pm_root: string
): ImportDryRunPlan {
  const request = buildImportRequestPlan(options.team, options.limit, {
    project: options.project,
    assignee: options.assignee,
    label: options.label,
    updatedSince: options.updatedSince,
    state: options.stateFilter,
    cycle: options.cycleFilter,
  });
  // Local-only read; no Linear network call. Reports how many already-linked pm
  // items exist so the preview can hint at create-vs-update without fetching.
  let existingLinkedItems = 0;
  try {
    existingLinkedItems = Object.keys(
      indexItemsByLinearId(readPmItems(pm_root))
    ).length;
  } catch {
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

// ---------------------------------------------------------------------------
// Atomic Linear import (pm-cli >= 2026.7.20 commitItemMutations)
// ---------------------------------------------------------------------------
//
// `pm linear import/sync --atomic` commits the ENTIRE batch (creates + updates
// + closes) as ONE workspace-writer-locked, crash-resumable transaction via the
// SDK `commitItemMutations` helper. On ordinary failure every applied mutation
// is compensated in reverse order; if compensation itself is incomplete the
// tracker MAY hold partial state and the error tells the user to retry the same
// import to resume the durable journal. The non-atomic path is byte-compatible
// (unchanged); --atomic --dry-run shares the atomic preparation/matching path
// and reports create/update/skip counts WITHOUT touching the SDK commit.

const ATOMIC_IMPORT_PREFIX = "linear-import-";

type CommitItemMutations = (
  options: CommitItemMutationsOptions,
) => Promise<CommitItemMutationsResult>;
type NormalizeItemId = (input: string, prefix: string) => string;
type ReadSettings = (pmRoot: string) => Promise<{ id_prefix?: string }>;

export interface AtomicImportOptions {
  /** Author attributed to the atomic transaction journal (defaults to `pm-linear`). */
  atomicAuthor?: string;
  /** Test seam: inject the SDK commit helper (skips SDK resolution). */
  commitItemMutations?: CommitItemMutations;
  /** Test seam: inject normalizeItemId (skips SDK resolution). */
  normalizeItemId?: NormalizeItemId;
  /** Test seam: inject readSettings (skips SDK resolution). */
  readSettings?: ReadSettings;
}

/** Fully rendered desired state for one Linear issue import. */
export interface PreparedLinearImport {
  // The STABLE external key: Linear's human-facing issue identifier (e.g.
  // "ENG-123"). Never the fetch order or the positional index. The deterministic
  // managed item id is derived from this so a reordered retry resumes the same
  // journal, and a prior interrupted attempt's provenance scan finds the item.
  identifier: string;
  // Linear's internal UUID. Carried for provenance/dedupe parity (the existing
  // indexItemsByLinearId match keys on this), but NOT used as the managed id.
  linearId: string;
  title: string;
  status: string;
  priority: number;
  description: string; // provenance marker
  body: string;
  tags: string[];
  deadline?: string;
  assignee?: string;
  match?: PmItem;
}

function assertSdkFunction<F>(fn: unknown, exportName: string): F {
  if (typeof fn !== "function") {
    throw new CommandError(
      `--atomic requires @unbrained/pm-cli>=2026.7.20 with the commitItemMutations SDK primitive, but the installed SDK does not export ${exportName} as a function. Upgrade @unbrained/pm-cli to >=2026.7.20.`,
      EXIT_CODE.USAGE,
    );
  }
  return fn as F;
}

async function loadAtomicSdk(
  importSdk: () => Promise<Partial<typeof import("@unbrained/pm-cli/sdk")>> =
    () => import("@unbrained/pm-cli/sdk"),
): Promise<Partial<typeof import("@unbrained/pm-cli/sdk")>> {
  try {
    return await importSdk();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `--atomic requires @unbrained/pm-cli>=2026.7.20, but the SDK could not be imported: ${msg}. Install or upgrade @unbrained/pm-cli.`,
      EXIT_CODE.USAGE,
    );
  }
}

async function resolveAtomicSdkFunctions(opts: AtomicImportOptions): Promise<{
  commitItemMutations: CommitItemMutations;
  normalizeItemId: NormalizeItemId;
  readSettings: ReadSettings;
}> {
  const needsSdk =
    !opts.commitItemMutations || !opts.normalizeItemId || !opts.readSettings;
  const mod = needsSdk ? await loadAtomicSdk() : undefined;
  return {
    commitItemMutations: opts.commitItemMutations ??
      assertSdkFunction<CommitItemMutations>(
        mod?.commitItemMutations,
        "commitItemMutations",
      ),
    normalizeItemId: opts.normalizeItemId ??
      assertSdkFunction<NormalizeItemId>(mod?.normalizeItemId, "normalizeItemId"),
    readSettings: opts.readSettings ??
      assertSdkFunction<ReadSettings>(mod?.readSettings, "readSettings"),
  };
}

/**
 * Derive an order-independent transaction id from the desired import state and
 * the exact ordered mutation plan. Content or target changes produce a fresh
 * transaction; a reordered retry of the same plan resumes the durable journal.
 * Canonical entries are sorted by the STABLE external key (the Linear issue
 * identifier), never by fetch order.
 */
export function deriveAtomicTransactionId(
  team: string,
  entries: readonly PreparedLinearImport[],
  mutations: readonly BulkItemMutation[],
): string {
  const canonical = [...entries]
    .sort((a, b) => (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0))
    .map((entry) => ({
      identifier: entry.identifier,
      linearId: entry.linearId,
      title: entry.title,
      status: entry.status,
      priority: entry.priority,
      description: entry.description,
      body: entry.body,
      tags: [...entry.tags].sort(),
      deadline: entry.deadline ?? null,
      assignee: entry.assignee ?? null,
    }));
  const digest = crypto
    .createHash("sha256")
    .update(team.toLowerCase())
    .update("\x1f")
    .update(JSON.stringify(canonical))
    .update("\x1f")
    // Recovery requires the exact ordered step plan. Include targets and
    // options so a changed id_prefix or provenance match gets a fresh journal
    // instead of colliding with an incompatible prior attempt.
    .update(JSON.stringify(mutations))
    .digest("hex")
    .slice(0, 16);
  return `${ATOMIC_IMPORT_PREFIX}${digest}`;
}

/**
 * Stable create id keyed by the STABLE external identifier (Linear issue
 * identifier like "ENG-123"), never by fetch order. The Linear issue
 * identifier is the most stable, human-meaningful external key and is what a
 * reordered retry reproduces exactly.
 */
export function deriveAtomicItemId(
  team: string,
  identifier: string,
  idPrefix: string,
  normalizeItemId: (input: string, prefix: string) => string,
): string {
  const teamToken = crypto
    .createHash("sha256")
    .update(team.toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return normalizeItemId(`linear-${teamToken}-${identifier}`, idPrefix);
}

/** Map one rendered import entry to its reversible SDK mutation sequence. */
export function buildAtomicImportMutations(
  team: string,
  entry: PreparedLinearImport,
  idPrefix: string,
  normalizeItemId: (input: string, prefix: string) => string,
): { itemId: string; mutations: BulkItemMutation[] } {
  // `status` is deliberately NOT a shared field. An existing item that is
  // already closed upstream must keep its closed state on re-sync: spreading a
  // shared `status: "open"` into the update step would reopen it, and the
  // follow-up close would re-close it — churning notifications, activity logs,
  // and webhooks on every run. Each mutation sets status explicitly instead
  // (create seeds a valid open item; update only carries status for non-closed
  // entries; the close step owns the closed transition).
  const sharedOptions: Record<string, unknown> = {
    title: entry.title,
    priority: entry.priority,
    description: entry.description,
    body: entry.body,
    // Sort before joining so the mutations slice of the transaction-id hash is
    // independent of Linear label-node order; a reordered retry resumes the same
    // journal instead of starting a fresh one (the canonical-entries side in
    // deriveAtomicTransactionId already sorts tags).
    tags: [...entry.tags].sort().join(","),
    ...(entry.deadline ? { deadline: entry.deadline } : {}),
    ...(entry.assignee ? { assignee: entry.assignee } : {}),
  };

  const managedItemId = deriveAtomicItemId(
    team,
    entry.identifier,
    idPrefix,
    normalizeItemId,
  );

  // A missing match and a match at our deterministic external-key id use the
  // SAME create+update upsert plan. This is essential for crash recovery: if a
  // prior attempt stopped after create, the next provenance scan sees that
  // item, but commitItemMutations must still receive the original plan. The
  // create step treats an existing stable id as already applied; update then
  // makes later content-bearing transactions refresh the item normally. The
  // close transition is a separate mutation so its reason is preserved and it
  // is reversible independently of the field update.
  if (!entry.match?.id || entry.match.id === managedItemId) {
    const mutations: BulkItemMutation[] = [
      {
        op: "create",
        id: managedItemId,
        options: {
          ...sharedOptions,
          // A brand-new item must be created in a valid open state; the close
          // step below performs the closed transition when required.
          status: entry.status === "closed" ? "open" : entry.status,
        },
      },
      {
        op: "update",
        id: managedItemId,
        options: {
          ...sharedOptions,
          ...(entry.status !== "closed" ? { status: entry.status } : {}),
        },
      },
    ];
    if (entry.status === "closed") {
      mutations.push({
        op: "close",
        id: managedItemId,
        reason: `Linear issue ${entry.identifier} closed`,
      });
    }
    return { itemId: managedItemId, mutations };
  }

  const itemId = entry.match.id;
  const updateOptions: Record<string, unknown> = { ...sharedOptions };
  if (entry.status !== "closed") {
    updateOptions.status = entry.status;
  }
  const mutations: BulkItemMutation[] = [
    { op: "update", id: itemId, options: updateOptions },
  ];
  if (entry.status === "closed") {
    mutations.push({
      op: "close",
      id: itemId,
      reason: `Linear issue ${entry.identifier} closed`,
    });
  }
  return { itemId, mutations };
}

/** Commit a complete issue-import batch under one crash-resumable transaction. */
export async function importLinearAtomic(
  pmRoot: string,
  team: string,
  entries: readonly PreparedLinearImport[],
  opts: AtomicImportOptions = {},
): Promise<{
  transactionId: string;
  recovered: boolean;
  imported: number;
  updated: number;
  recoveredItems?: number;
  itemIds: Map<string, string>;
}> {
  const {
    commitItemMutations: commit,
    normalizeItemId,
    readSettings,
  } = await resolveAtomicSdkFunctions(opts);

  // The atomic identity — every managed item id AND the durable transaction id
  // — is derived from id_prefix. readSettings already resolves a missing or
  // malformed settings file to defaults WITHOUT throwing, so a thrown error
  // here is a genuine filesystem fault (e.g. EACCES/EIO). Silently falling back
  // to "pm-" in that case would fork the identity of a retry from the original
  // run: the resume would key a *different* journal and could duplicate every
  // item. Fail loudly instead so the operator resolves the fault and re-runs
  // the same, resumable transaction.
  let idPrefix = "pm-";
  try {
    const settings = await readSettings(pmRoot);
    if (settings?.id_prefix) idPrefix = String(settings.id_prefix);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `Atomic Linear import could not read workspace settings to resolve id_prefix: ${msg}. ` +
        `The transaction identity is keyed on id_prefix, so proceeding with a fallback could duplicate items; ` +
        `resolve the settings read error and retry the same import to resume its durable journal.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  const mutations: BulkItemMutation[] = [];
  const itemIds = new Map<string, string>();
  // The transaction journal fingerprints the ordered step plan. Canonicalize
  // by the stable Linear identifier so a retry whose API page/order changed
  // supplies the exact same plan as well as the same transaction id.
  for (const entry of [...entries].sort((a, b) =>
    a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0
  )) {
    const planned = buildAtomicImportMutations(team, entry, idPrefix, normalizeItemId);
    itemIds.set(entry.identifier, planned.itemId);
    mutations.push(...planned.mutations);
  }
  const transactionId = deriveAtomicTransactionId(team, entries, mutations);

  try {
    const result = await commit({
      pmRoot,
      transactionId,
      author: opts.atomicAuthor ?? "pm-linear",
      mutations,
      // This option selects how CREATE steps are compensated. The SDK's
      // commitItemMutations contract independently snapshots and version-
      // restores every UPDATE and CLOSE step (covered by the mixed rollback
      // integration test below this implementation).
      createCompensation: "delete",
    });
    // A recovered journal may include work applied by the interrupted process
    // as well as steps resumed now. The SDK intentionally returns the durable
    // final results, not a per-invocation delta, so create/update counts cannot
    // be reconstructed truthfully. Report the recovered batch separately.
    const recovered = Boolean(result?.recovered);
    return {
      transactionId,
      recovered,
      imported: recovered ? 0 : entries.filter((e) => !e.match?.id).length,
      updated: recovered ? 0 : entries.filter((e) => Boolean(e.match?.id)).length,
      ...(recovered ? { recoveredItems: entries.length } : {}),
      itemIds,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof AggregateError || /compensation failed/i.test(msg)) {
      throw new CommandError(
        `Atomic Linear import failed and compensation was incomplete. The tracker may contain partially applied state; retry the same import to resume transaction ${transactionId}, then inspect its durable journal if recovery still fails. Underlying error: ${msg}`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    if (err instanceof Error && err.name === "WorkspaceTransactionInterruptedError") {
      throw new CommandError(
        `Atomic Linear import was interrupted. Its durable journal is resumable; retry the same import to continue transaction ${transactionId}. Underlying error: ${msg}`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    throw new CommandError(
      `Atomic Linear import failed after the SDK completed its normal compensation path; no new partial committed state is expected. Transaction id: ${transactionId}. Underlying error: ${msg}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

export async function syncLinearIssues(
  options: SyncOptions,
  pm_root: string,
  dependencies: SyncRunDependencies = {},
): Promise<SyncResult> {
  const apiKey = process.env["LINEAR_API_KEY"];
  // An injected fetchIssues seam (tests/offline) does not need a real key; only
  // the live fetchAllLinearIssues path requires one. Skip the check when the
  // caller supplies its own fetch so the atomic prep/dry-run path is exercisable
  // offline without leaking the requirement onto the test seam.
  if (!apiKey && !dependencies.fetchIssues) {
    throw new CommandError(
      "LINEAR_API_KEY environment variable is not set. " +
        "Get your API key at https://linear.app/settings/api",
      EXIT_CODE.USAGE
    );
  }

  const filters: FetchFilters = {
    project: options.project,
    assignee: options.assignee,
    label: options.label,
    updatedSince: options.updatedSince,
    state: options.stateFilter,
    cycle: options.cycleFilter,
  };

  // --dry-run is fully OFFLINE: build and PRINT the exact GraphQL request that
  // WOULD be sent (query + variables), make NO network call, and report against
  // the local workspace only. This is handled in the command/importer handler
  // (which has access to the JSON-mode flag); syncLinearIssues is only reached
  // here for real writes, so a missing/invalid key surfaces as a real error.
  const scopeBits: string[] = [];
  if (options.project) scopeBits.push(`project "${options.project}"`);
  if (options.assignee) scopeBits.push(`assignee ${options.assignee}`);
  if (options.label) scopeBits.push(`label "${options.label}"`);
  if (options.updatedSince) scopeBits.push(`updated since ${options.updatedSince}`);
  if (options.stateFilter) scopeBits.push(`state "${options.stateFilter}"`);
  if (options.cycleFilter) scopeBits.push(`cycle "${options.cycleFilter}"`);
  const scope = scopeBits.length ? ` (${scopeBits.join(", ")})` : "";
  console.error(`Fetching issues from Linear team: ${options.team}${scope} (limit: ${options.limit})`);

  const issues = await (dependencies.fetchIssues ?? fetchAllLinearIssues)(apiKey ?? "", options.team, options.limit, filters);

  if (issues.length === 0) {
    console.error(`No issues found for team "${options.team}"${scope}. Check the team slug, filters, and your API key permissions.`);
    return { synced: 0, created: 0, updated: 0, skipped: 0, team: options.team, issues: [] };
  }

  const statusMap = options.statusMap ?? {};

  // Idempotency: index existing items by stored Linear id so a re-import
  // UPDATES the matching item rather than creating a duplicate. We only read
  // the workspace when actually writing (dry-run is read-free on Linear's side
  // but we still want the preview to report create-vs-update accurately).
  const existingByLinearId = indexItemsByLinearId((dependencies.readItems ?? readPmItems)(pm_root));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  // -------------------------------------------------------------------------
  // --atomic: commit the whole batch as ONE crash-resumable transaction via
  // the SDK commitItemMutations helper. --atomic --dry-run shares this exact
  // preparation/matching path and reports counts WITHOUT touching the commit.
  // The non-atomic per-issue loop below stays byte-compatible (unchanged).
  // -------------------------------------------------------------------------
  if (options.atomic) {
    const prepared: PreparedLinearImport[] = [];
    for (const issue of issues) {
      // Reuse the same server-side state/cycle backstop filters as the legacy
      // path so `--atomic` skips the same issues and reports the same counts.
      if (options.stateFilter) {
        const stateName = issue.state.name.toLowerCase();
        if (!stateName.includes(options.stateFilter.toLowerCase())) {
          skipped++;
          continue;
        }
      }
      if (options.cycleFilter) {
        const cycleName = issue.cycle?.name?.toLowerCase() ?? "";
        if (!cycleName.includes(options.cycleFilter.toLowerCase())) {
          skipped++;
          continue;
        }
      }
      const plan = buildItemPlan(
        issue,
        statusMap,
        options.fieldMap ?? {},
        options.projectMap ?? { enabled: false, passthrough: false, map: {} }
      );
      prepared.push({
        identifier: issue.identifier,
        linearId: issue.id,
        title: plan.title,
        status: plan.status,
        priority: plan.priority,
        description: plan.description,
        body: plan.body,
        tags: plan.tags,
        ...(plan.deadline ? { deadline: plan.deadline } : {}),
        ...(plan.assignee ? { assignee: plan.assignee } : {}),
        match: existingByLinearId[issue.id],
      });
    }

    if (options.dryRun) {
      const wouldCreate = prepared.filter((e) => !e.match?.id).length;
      const wouldUpdate = prepared.length - wouldCreate;
      console.error(
        `[dry-run] Atomic plan would import ${wouldCreate}, update ${wouldUpdate}, skip ${skipped}.`
      );
      return {
        synced: wouldCreate + wouldUpdate,
        created: wouldCreate,
        updated: wouldUpdate,
        skipped,
        team: options.team,
        issues: [],
        atomic: true,
        dryRun: true,
      };
    }

    // All-skipped (e.g. every issue filtered out by --state/--cycle): return a
    // successful zero-sync result BEFORE touching the SDK, matching the legacy
    // non-atomic path, which never errors on an all-filtered batch. `skipped`
    // counts issues dropped by a filter — an expected, common state for a
    // scheduled sync — not failures, so throwing here would break cron/CI jobs.
    if (prepared.length === 0) {
      console.error(
        `No Linear issues to import after filters (skipped ${skipped}); nothing to commit.`
      );
      return {
        synced: 0,
        created: 0,
        updated: 0,
        skipped,
        team: options.team,
        issues: [],
        atomic: true,
      };
    }

    const atomicResult = await (dependencies.commitAtomic ?? importLinearAtomic)(pm_root, options.team, prepared);
    if (atomicResult.recovered) {
      console.error(
        `Atomic import recovered transaction ${atomicResult.transactionId} covering ${atomicResult.recoveredItems ?? prepared.length} item(s).`
      );
    } else {
      console.error(
        `Atomically imported ${atomicResult.imported} new, updated ${atomicResult.updated} existing, skipped ${skipped}.`
      );
    }
    return {
      synced: atomicResult.imported + atomicResult.updated,
      created: atomicResult.imported,
      updated: atomicResult.updated,
      skipped,
      team: options.team,
      issues: [],
      atomic: true,
      transactionId: atomicResult.transactionId,
      recovered: atomicResult.recovered,
      ...(atomicResult.recoveredItems !== undefined
        ? { recoveredItems: atomicResult.recoveredItems }
        : {}),
    };
  }

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

    // Cycle name filter. The authoritative constraint is server-side
    // (`cycle: { name: { containsIgnoreCase: $cycle } }` in buildIssuesQuery),
    // so `--limit` bounds the MATCHING issues. This identical case-insensitive
    // substring check is a harmless backstop; the server applies the same
    // predicate, so it never drops a server hit. An issue with no cycle never
    // matches a cycle filter (server-side null cycle is excluded too).
    if (options.cycleFilter) {
      const cycleName = issue.cycle?.name?.toLowerCase() ?? "";
      if (!cycleName.includes(options.cycleFilter.toLowerCase())) {
        skipped++;
        continue;
      }
    }

    // `pm create` has no generic setter for the registerItemFields custom
    // fields from a standalone extension, so buildItemPlan persists Linear
    // provenance in the description behind a stable marker. This survives
    // round-trips and is what re-import + `pm linear export` read back to stay
    // idempotent. The same builder feeds the offline --dry-run preview.
    const plan = buildItemPlan(
      issue,
      statusMap,
      options.fieldMap ?? {},
      options.projectMap ?? { enabled: false, passthrough: false, map: {} }
    );
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
      if (body) updateArgs.push("--body", body);
      if (tags.length > 0) updateArgs.push("--tags", tags.join(","));
      if (plan.deadline) updateArgs.push("--deadline", plan.deadline);
      if (plan.assignee) updateArgs.push("--assignee", plan.assignee);

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
      if (plan.deadline) createArgs.push("--deadline", plan.deadline);
      if (plan.assignee) createArgs.push("--assignee", plan.assignee);

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
  // Symmetric with the importer: pm priority -> Linear priority int (0..4),
  // pm tags -> Linear label names (resolved to labelIds at push time), and pm
  // deadline -> Linear dueDate (bare YYYY-MM-DD). undefined => field omitted.
  priority?: number;
  labels?: string[];
  dueDate?: string;
  // Linear estimate (story points) round-tripped from the importer's
  // `estimate:<n>` tag back onto the issue input. undefined => omitted.
  estimate?: number;
  // Linear cycle (sprint) NAME round-tripped from the importer's `cycle:<name>`
  // tag. The push resolves the name to a concrete cycleId per team; offline the
  // name is carried so the plan/preview is complete. undefined => omitted.
  cycleName?: string;
  alreadyInLinear: boolean;
  linearId?: string;
  linearUrl?: string;
}

// Pull a single integer estimate out of pm tags shaped `estimate:<n>` (mirrors
// the importer's Linear-estimate -> tag mapping). Returns the parsed finite int
// or undefined. Pure + exported for testing. Last well-formed tag wins.
export function parseEstimateTag(tags: string[]): number | undefined {
  let result: number | undefined;
  for (const t of tags) {
    const m = /^estimate:(.+)$/i.exec(t.trim());
    if (!m) continue;
    const n = Number(m[1].trim());
    if (Number.isFinite(n)) result = n;
  }
  return result;
}

// Pull a cycle NAME out of pm tags shaped `cycle:<name>` (mirrors the importer's
// Linear-cycle -> tag mapping). Returns the trimmed name or undefined. Pure +
// exported for testing. Last non-empty tag wins.
export function parseCycleTag(tags: string[]): string | undefined {
  let result: string | undefined;
  for (const t of tags) {
    const m = /^cycle:(.+)$/i.exec(t.trim());
    if (!m) continue;
    const name = m[1].trim();
    if (name) result = name;
  }
  return result;
}

// True when a tag is one of the namespaced round-trip encodings the exporter
// promotes to first-class issue fields (estimate/cycle) rather than a Linear
// label. Pure: keeps those tags from being emitted as labels (Linear would
// reject them as unknown label names anyway).
export function isReservedExportTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return t.startsWith("estimate:") || t.startsWith("cycle:");
}

// Pure transform: pm item -> Linear issue payload. Items that already carry
// Linear provenance are flagged (and keep their linear id) so `--push` UPDATES
// them in place instead of creating a duplicate. priority/labels/dueDate mirror
// the importer's Linear->pm mapping so an exported item round-trips its
// priority, tags (as labels), and deadline (as dueDate).
export function itemToLinearPayload(
  item: PmItem,
  fieldMap: Record<string, string> = {}
): LinearCreatePayload {
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
  const payload: LinearCreatePayload = {
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
  if (typeof estimate === "number") payload.estimate = estimate;
  if (cycleName) payload.cycleName = cycleName;
  const dueDate = normalizeDueDate(item.deadline);
  if (dueDate) payload.dueDate = dueDate;
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

interface TeamContext {
  teamId: string;
  // Linear state name (lower-cased) -> state id, for status push.
  statesByName: Record<string, string>;
  // Linear label name (lower-cased) -> label id, for label push. Names that
  // don't resolve to an existing team label are dropped (Linear rejects unknown
  // ids), so the push never fails on a tag the workspace doesn't model.
  labelsByName: Record<string, string>;
  // Linear cycle name/number (lower-cased) -> cycle id, for cycle push. The
  // importer encodes cycles as `cycle:<name>`; named AND numbered cycles are
  // indexed (a numbered cycle has no name, only `number`). Unresolved names are
  // skipped gracefully so the push never fails on an unknown cycle.
  cyclesByName: Record<string, string>;
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
  const labelsByName: Record<string, string> = {};
  for (const l of node.labels?.nodes ?? []) {
    if (l?.name && l?.id) labelsByName[String(l.name).trim().toLowerCase()] = l.id;
  }
  const cyclesByName: Record<string, string> = {};
  for (const c of node.cycles?.nodes ?? []) {
    if (!c?.id) continue;
    if (c.name) cyclesByName[String(c.name).trim().toLowerCase()] = c.id;
    // Numbered cycles often have no name; index by number too so a
    // `cycle:42` tag still resolves.
    if (c.number != null) cyclesByName[String(c.number).trim().toLowerCase()] = c.id;
  }
  return { teamId: node.id, statesByName, labelsByName, cyclesByName };
}

// Resolve pm tags (label names) to existing Linear label ids for this team.
// Unknown names are silently dropped so a push never fails on a tag the team
// doesn't model. Pure + exported for unit testing.
export function resolveLabelIds(
  labels: string[] | undefined,
  labelsByName: Record<string, string>
): string[] {
  if (!labels?.length) return [];
  const ids: string[] = [];
  for (const name of labels) {
    const id = labelsByName[name.trim().toLowerCase()];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Resolve a Linear cycle NAME (or number) to its concrete cycle id for this
// team. Returns undefined when the name does not match any cycle (offline,
// unknown, or a workspace that doesn't model the cycle) so the push can skip
// the field gracefully rather than crash. Pure + exported for unit testing.
export function resolveCycleId(
  cycleName: string | undefined,
  cyclesByName: Record<string, string>
): string | undefined {
  if (!cycleName) return undefined;
  return cyclesByName[cycleName.trim().toLowerCase()];
}

// Apply estimate + (resolved) cycleId onto a REAL push input (issueCreate or
// issueUpdate). estimate is a finite number copied straight through. cycle is
// resolved by name to a concrete id via the team context; an unresolvable cycle
// is skipped (NOT crashed) and warned about once per process so a batch push of
// many items isn't spammed. Returns the (possibly mutated) input for chaining.
let warnedUnresolvedCycle = false;
export function resetCycleWarning(): void {
  warnedUnresolvedCycle = false;
}
export function applyPushDynamicFields(
  input: Record<string, unknown>,
  payload: LinearCreatePayload,
  cyclesByName: Record<string, string>,
  warn: (msg: string) => void = (m) => console.error(m)
): void {
  if (typeof payload.estimate === "number" && Number.isFinite(payload.estimate)) {
    input.estimate = payload.estimate;
  }
  if (payload.cycleName) {
    const cycleId = resolveCycleId(payload.cycleName, cyclesByName);
    if (cycleId) {
      input.cycleId = cycleId;
    } else if (!warnedUnresolvedCycle) {
      warnedUnresolvedCycle = true;
      warn(
        `Linear cycle "${payload.cycleName}" did not match any cycle on the team; ` +
          `skipping cycle assignment (further unresolved cycles suppressed).`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Build the would-be Linear GraphQL mutation(s) for one export payload WITHOUT
// any network call. A linked item (alreadyInLinear) becomes an issueUpdate; a
// fresh item becomes an issueCreate (teamId resolved at push time — here it is
// a placeholder so the offline plan is complete + readable). The target state
// is resolved by NAME offline; the concrete stateId is only knowable with creds
// at push time, so the plan reports the resolved name. Pure + exported.
// ---------------------------------------------------------------------------
export interface ExportMutationPlan {
  action: "create" | "update";
  mutation: string;
  variables: Record<string, unknown>;
  targetStateName: string | null;
}

// Apply the priority/labels/dueDate fields onto an issue input, symmetric with
// the importer. priority is included whenever it resolves to a concrete Linear
// int (including 0 = "No priority", which is a valid explicit clear). labels are
// passed through by NAME in the offline plan as `labelNames` (a placeholder the
// real push resolves to `labelIds` per team); an empty list is omitted. dueDate
// is the bare YYYY-MM-DD. Pure helper so the plan + the real push agree. The
// `labelIds` placeholder string makes the offline dry-run self-documenting about
// how names become ids at push time without inventing fake ids.
function applyExportFields(input: Record<string, unknown>, payload: LinearCreatePayload): void {
  if (typeof payload.priority === "number") input.priority = payload.priority;
  if (payload.labels && payload.labels.length > 0) {
    input.labelNames = payload.labels;
    input.labelIds = payload.labels.map((n) => `<label-id-for:${n}>`);
  }
  if (payload.dueDate) input.dueDate = payload.dueDate;
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

export function buildExportMutationPlan(
  payload: LinearCreatePayload,
  invertedStatusMap: Record<string, string>,
  teamKey?: string
): ExportMutationPlan {
  const targetStateName = resolveLinearStateName(payload.pmStatus, invertedStatusMap) ?? null;
  if (payload.alreadyInLinear && payload.linearId) {
    const input: Record<string, unknown> = {
      title: payload.title,
      description: payload.description,
    };
    if (targetStateName) input.stateName = targetStateName;
    applyExportFields(input, payload);
    return {
      action: "update",
      mutation: ISSUE_UPDATE_MUTATION,
      variables: { id: payload.linearId, input },
      targetStateName,
    };
  }
  const input: Record<string, unknown> = {
    teamId: teamKey ? `<resolved-id-for-${teamKey.toUpperCase()}>` : "<team-id>",
    title: payload.title,
    description: payload.description,
  };
  if (targetStateName) input.stateName = targetStateName;
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

// Mask an API key for diagnostics: never reveal more than a short prefix.
// Pure + exported for testing. "" / undefined -> "".
export function maskApiKey(key: string | undefined): string {
  if (!key) return "";
  const head = key.slice(0, 4);
  return `${head}…(${key.length} chars)`;
}

// Structured readiness report. Pure aside from reading env (which is the point).
interface ValidationReport {
  apiKeyPresent: boolean;
  apiKeyMasked: string;
  defaultTeam: string | undefined;
  readyForWrites: boolean;
  networkChecked: boolean;
  networkOk: boolean;
  networkError?: string;
}

function buildValidationReport(): ValidationReport {
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
function assertPreflightOk(options: Record<string, unknown>): void {
  const err = options[PREFLIGHT_ERROR_OPTION];
  if (typeof err === "string" && err) {
    throw new CommandError(err, EXIT_CODE.USAGE);
  }
}

// True when the caller passed the GLOBAL --json flag. pm exposes it on
// ctx.global.json; in JSON mode handlers return the object and must NOT write
// their own stdout (the runtime serializes the return value).
function isJsonMode(ctx: any): boolean {
  return Boolean(ctx?.global?.json);
}

// Render an offline import dry-run: build the literal GraphQL request (no
// network) and either return the plan object (JSON mode) or print a human
// preview to stderr. Shared by `linear sync` and the `linear` importer so both
// dry-run paths are identical and network-free. Returns the JSON-mode payload.
function renderImportDryRun(
  ctx: any,
  options: SyncOptions,
  teamSource?: TeamSource
): Record<string, unknown> {
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
    console.error(
      `Existing Linear-linked pm items: ${plan.existingLinkedItems} ` +
        `(matched issues would update; the rest would be created).`
    );
    if (Object.keys(plan.statusMap).length) {
      console.error(`Status map: ${JSON.stringify(plan.statusMap)}`);
    }
    if (Object.keys(plan.fieldMap).length) {
      console.error(`Field map: ${JSON.stringify(plan.fieldMap)}`);
    }
    if (plan.projectMap.enabled) {
      console.error(
        `Project map: ${
          plan.projectMap.passthrough
            ? "passthrough (tag = Linear project name)"
            : JSON.stringify(plan.projectMap.map)
        }`
      );
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
  version: "2026.7.19",

  activate(api) {
    // -----------------------------------------------------------------------
    // preflight — validate credentials + reachability before any mutating
    // Linear command runs. On failure it injects a sentinel option (it cannot
    // abort by throwing) that the handlers convert into a clean USAGE error.
    // -----------------------------------------------------------------------
    api.registerPreflight(async (ctx: any) => {
      if (!commandMutatesLinear(ctx.command, ctx.options)) return {};
      // Reachability uses the network; allow opting out (CI/offline/tests).
      // pm strips a leading `--no-` as boolean negation, so the user-facing flag
      // is `--skip-preflight-network` (the legacy `no-preflight-network` key is
      // still honored for back-compat with any existing scripts/config).
      const checkReachability =
        !readBooleanOption(ctx.options, "skip-preflight-network") &&
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
        "LINEAR_DEFAULT_TEAM=ENG pm linear sync",
        "pm linear sync --team ENG --state 'In Progress'",
        "pm linear sync --team ENG --assignee dev@acme.com --label bug",
        "pm linear sync --team ENG --cycle 'Sprint 7' --limit 50",
        "pm linear sync --team ENG --limit 50",
        "pm linear sync --team ENG --dry-run",
        "pm linear sync --team ENG --atomic",
      ],
      flags: [
        { long: "--team", value_name: "slug", description: "Linear team slug (e.g. ENG, BACKEND). Optional when LINEAR_DEFAULT_TEAM is set." },
        { long: "--project", value_name: "name", description: "Filter by Linear project name. Optional." },
        { long: "--state", value_name: "name", description: "Filter by Linear state name (e.g. 'In Progress', 'Todo'). Optional." },
        { long: "--cycle", value_name: "name", description: "Filter by Linear cycle name (e.g. 'Sprint 7', 'Q3'). Case-insensitive substring match; issues with no cycle are excluded. Optional." },
        { long: "--assignee", value_name: "email", description: "Filter by assignee email. Optional." },
        { long: "--label", value_name: "name", description: "Filter by label name. Optional." },
        { long: "--updated-since", value_name: "date", description: "Only issues updated at/after this ISO date or duration (e.g. 2026-01-01, -P7D). Optional." },
        { long: "--status-map", value_name: "map", description: "Override status mapping, e.g. \"In Review=in_progress,Backlog=open\". Optional." },
        { long: "--map", value_name: "map", description: "Remap Linear->pm fields, e.g. \"identifier=ignore,priority=ignore\". Optional." },
        { long: "--project-map", value_name: "map", description: "Tag items by Linear project name. Bare flag tags with the verbatim name; \"Mobile=mobile,Web=web\" remaps. Optional." },
        { long: "--limit", value_name: "n", description: "Maximum number of issues to fetch (default: 100)" },
        { long: "--atomic", description: "Commit the complete sync as one workspace-writer-locked, crash-resumable transaction (pm-cli >=2026.7.20); compensate applied mutations on failure and report incomplete compensation" },
        { long: "--dry-run", description: "Preview the exact GraphQL request without any network call or writes" },
        { long: "--skip-preflight-network", description: "Skip the preflight reachability probe (offline/CI)" },
      ],

      async run(ctx) {
        assertPreflightOk(ctx.options);
        const teamSelection = resolveTeamSelection(ctx.options);
        if (!teamSelection) {
          throw new CommandError(
            "Missing Linear team. Pass --team <slug> or set LINEAR_DEFAULT_TEAM. " +
              "Example: pm linear sync --team ENG",
            EXIT_CODE.USAGE
          );
        }
        const team = teamSelection.team;
        const project = readStringOption(ctx.options, "project");
        const stateFilter = readStringOption(ctx.options, "state");
        const cycleFilter = normalizeCycleFilter(readStringOption(ctx.options, "cycle"));
        const assignee = readStringOption(ctx.options, "assignee");
        const label = readStringOption(ctx.options, "label");
        const updatedSince = readStringOption(ctx.options, "updated-since");
        const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
        const fieldMap = parseFieldMap(readStringOption(ctx.options, "map"));
        const projectMap = parseProjectMap(readProjectMapOption(ctx.options));
        const limit = readNumberOption(ctx.options, "limit") ?? 100;
        const dryRun = readBooleanOption(ctx.options, "dry-run");
        const atomic = readBooleanOption(ctx.options, "atomic");

        const syncOpts: SyncOptions = {
          team, project, stateFilter, cycleFilter, assignee, label, updatedSince,
          statusMap, fieldMap, projectMap, limit, dryRun, atomic,
        };

        // --dry-run is fully offline: print the literal GraphQL request, no call.
        // --atomic --dry-run is NOT offline: it fetches issues, shares the atomic
        // preparation/matching path, and reports create/update/skip counts
        // WITHOUT committing — handled inside syncLinearIssues.
        if (dryRun && !atomic) {
          return renderImportDryRun(ctx, syncOpts, teamSelection.source);
        }

        if (!isJsonMode(ctx) && teamSelection.source === "env") {
          console.error(`Using LINEAR_DEFAULT_TEAM=${team.toUpperCase()} (no --team provided).`);
        }

        try {
          const result = await syncLinearIssues(syncOpts, ctx.pm_root);

          if (result.atomic) {
            // syncLinearIssues already printed the atomic summary line.
            return {
              success: true,
              synced: result.synced,
              created: result.created,
              updated: result.updated,
              skipped: result.skipped,
              team: result.team.toUpperCase(),
              teamSource: teamSelection.source,
              atomic: true,
              dryRun: Boolean(result.dryRun),
              ...(result.transactionId !== undefined ? { transactionId: result.transactionId } : {}),
              ...(result.recovered !== undefined ? { recovered: result.recovered } : {}),
              ...(result.recoveredItems !== undefined ? { recoveredItems: result.recoveredItems } : {}),
            };
          }

          const summary =
            `Synced ${result.synced} issue${result.synced !== 1 ? "s" : ""} ` +
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
            teamSource: teamSelection.source,
            dryRun: false,
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
          if (err) diag.networkError = err;
        }
        if (isJsonMode(ctx)) return diag;
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
      { long: "--cycle", value_name: "name", description: "Filter by Linear cycle name (case-insensitive substring; issues with no cycle are excluded)." },
      { long: "--assignee", value_name: "email", description: "Filter by assignee email." },
      { long: "--label", value_name: "name", description: "Filter by label name." },
      { long: "--updated-since", value_name: "date", description: "Only issues updated at/after this ISO date or duration." },
      { long: "--status-map", value_name: "map", description: "Override status mapping, e.g. \"In Review=in_progress\"." },
      { long: "--map", value_name: "map", description: "Remap Linear->pm fields, e.g. \"identifier=ignore\"." },
      { long: "--project-map", value_name: "map", description: "Tag items by Linear project name (bare flag = verbatim; \"Mobile=mobile\" remaps)." },
      { long: "--limit", value_name: "n", description: "Maximum number of issues to fetch (default: 100)." },
      { long: "--atomic", description: "Commit the complete import as one workspace-writer-locked, crash-resumable transaction (pm-cli >=2026.7.20); compensate applied mutations on failure and report incomplete compensation" },
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
        throw new CommandError(
          "Missing Linear team. Pass --team <slug> or set LINEAR_DEFAULT_TEAM. " +
            "Example: pm linear import --team ENG",
          EXIT_CODE.USAGE
        );
      }
      const team = teamSelection.team;
      const project = readStringOption(ctx.options, "project");
      const stateFilter = readStringOption(ctx.options, "state");
      const cycleFilter = normalizeCycleFilter(readStringOption(ctx.options, "cycle"));
      const assignee = readStringOption(ctx.options, "assignee");
      const label = readStringOption(ctx.options, "label");
      const updatedSince = readStringOption(ctx.options, "updated-since");
      const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
      const fieldMap = parseFieldMap(readStringOption(ctx.options, "map"));
      const projectMap = parseProjectMap(readProjectMapOption(ctx.options));
      const limit = readNumberOption(ctx.options, "limit") ?? 100;
      const dryRun = readBooleanOption(ctx.options, "dry-run");
      const atomic = readBooleanOption(ctx.options, "atomic");

      const syncOpts: SyncOptions = {
        team, project, stateFilter, cycleFilter, assignee, label, updatedSince,
        statusMap, fieldMap, projectMap, limit, dryRun, atomic,
      };

      // --dry-run is fully offline: emit the literal GraphQL request, no call.
      // --atomic --dry-run shares the atomic prep/matching path (fetches issues,
      // reports counts, no commit) - handled inside syncLinearIssues.
      if (dryRun && !atomic) {
        const plan = renderImportDryRun(ctx, syncOpts, teamSelection.source);
        return { imported: 0, created: 0, updated: 0, skipped: 0, ...plan };
      }

      if (!isJsonMode(ctx) && teamSelection.source === "env") {
        console.error(`Using LINEAR_DEFAULT_TEAM=${team.toUpperCase()} (no --team provided).`);
      }

      try {
        const result = await syncLinearIssues(syncOpts, ctx.pm_root);
        if (!result.atomic) {
          console.error(
            `Imported ${result.synced} issue(s) (${result.created} new, ${result.updated} updated) ` +
              `from Linear team ${result.team.toUpperCase()}` +
              (result.skipped > 0 ? ` (${result.skipped} skipped)` : "")
          );
        }
        return {
          imported: result.synced,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          team: result.team.toUpperCase(),
          teamSource: teamSelection.source,
          dryRun: Boolean(result.dryRun),
          ...(result.atomic ? { atomic: true } : {}),
          ...(result.transactionId !== undefined ? { transactionId: result.transactionId } : {}),
          ...(result.recovered !== undefined ? { recovered: result.recovered } : {}),
          ...(result.recoveredItems !== undefined ? { recoveredItems: result.recoveredItems } : {}),
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
        const plans = payloads.map((p) =>
          buildExportMutationPlan(p, invertedStatusMap, teamKey)
        );
        const wouldCreate = plans.filter((p) => p.action === "create").length;
        const wouldUpdate = plans.length - wouldCreate;
        if (!isJsonMode(ctx)) {
          console.error(
            `[dry-run] Would push ${plans.length} item(s): ${wouldCreate} create, ${wouldUpdate} update. No network call made.`
          );
          if (!teamKey && wouldCreate > 0) {
            console.error(
              "[dry-run] No team resolved for create payloads. Pass --team <slug> " +
                "or set LINEAR_DEFAULT_TEAM to render team-specific placeholders."
            );
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
          console.error(
            "[preview] No team resolved for create payloads. Pass --team <slug> " +
              "or set LINEAR_DEFAULT_TEAM to preview team-specific placeholders."
          );
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
        throw new CommandError(
          "--push requires LINEAR_API_KEY. Get a key at https://linear.app/settings/api",
          EXIT_CODE.USAGE
        );
      }
      if (!teamSelection) {
        throw new CommandError(
          "--push requires --team <slug> (or LINEAR_DEFAULT_TEAM).",
          EXIT_CODE.USAGE
        );
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
            const input: Record<string, unknown> = {
              title: payload.title,
              description: payload.description,
            };
            if (stateId) input.stateId = stateId;
            if (typeof payload.priority === "number") input.priority = payload.priority;
            if (labelIds.length > 0) input.labelIds = labelIds;
            if (payload.dueDate) input.dueDate = payload.dueDate;
            applyPushDynamicFields(input, payload, teamCtx.cyclesByName);
            const resp: any = await linearRequest(apiKey, ISSUE_UPDATE_MUTATION, {
              id: payload.linearId,
              input,
            });
            if (resp.errors?.length) {
              throw new Error(
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
          if (typeof payload.priority === "number") input.priority = payload.priority;
          if (labelIds.length > 0) input.labelIds = labelIds;
          if (payload.dueDate) input.dueDate = payload.dueDate;
          applyPushDynamicFields(input, payload, teamCtx.cyclesByName);
          const resp: any = await linearRequest(apiKey, ISSUE_CREATE_MUTATION, { input });
          if (resp.errors?.length) {
            throw new Error(
              `Linear issueCreate failed: ${resp.errors.map((e: any) => e.message).join("; ")}`
            );
          }
          created++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Failed to push item ${label}: ${message}`);
          skipped++;
          continue;
        }
      }
      console.error(
        `Pushed ${created + updated} issue(s) to Linear team ${team.toUpperCase()} ` +
          `(${created} created, ${updated} updated)` +
          (skipped > 0 ? ` — ${skipped} skipped (see errors above)` : "")
      );
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
        throw new CommandError(
          "linear-sync importer requires a 'team' option or LINEAR_DEFAULT_TEAM env var",
          EXIT_CODE.USAGE
        );
      }
      const team = teamSelection.team;
      if (!isJsonMode(ctx) && teamSelection.source === "env") {
        console.error(`Using LINEAR_DEFAULT_TEAM=${team.toUpperCase()} (no --team provided).`);
      }

      const limit = readNumberOption(ctx.options, "limit") ?? 100;
      const stateFilter = readStringOption(ctx.options, "state");
      const cycleFilter = normalizeCycleFilter(readStringOption(ctx.options, "cycle"));
      const project = readStringOption(ctx.options, "project");
      const assignee = readStringOption(ctx.options, "assignee");
      const label = readStringOption(ctx.options, "label");
      const statusMap = parseStatusMap(readStringOption(ctx.options, "status-map"));
      const projectMap = parseProjectMap(readProjectMapOption(ctx.options));
      const dryRun = readBooleanOption(ctx.options, "dry-run");
      const atomic = readBooleanOption(ctx.options, "atomic");

      const syncOpts: SyncOptions = {
        team, project, stateFilter, cycleFilter, assignee, label,
        statusMap, projectMap, limit, dryRun, atomic,
      };

      // --dry-run is fully offline: emit the literal GraphQL request, no call
      // and no writes. --atomic --dry-run shares the atomic prep/matching path
      // (fetches issues, reports counts, no commit) handled inside
      // syncLinearIssues, so dryRun is forwarded below. Without this guard,
      // syncLinearIssues would see dryRun=false and turn a requested preview
      // into a real workspace write.
      if (dryRun && !atomic) {
        const plan = renderImportDryRun(ctx, syncOpts, teamSelection.source);
        return {
          synced: 0,
          created: 0,
          updated: 0,
          skipped: 0,
          teamSource: teamSelection.source,
          ...plan,
        };
      }

      const result = await syncLinearIssues(syncOpts, ctx.pm_root);

      if (!result.atomic) {
        console.error(
          `Synced ${result.synced} issues (${result.created} new, ${result.updated} updated) ` +
            `from Linear team ${result.team.toUpperCase()}`
        );
      }

      return {
        synced: result.synced,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        team: result.team.toUpperCase(),
        teamSource: teamSelection.source,
        dryRun: Boolean(result.dryRun),
        ...(result.atomic ? { atomic: true } : {}),
        ...(result.transactionId !== undefined ? { transactionId: result.transactionId } : {}),
        ...(result.recovered !== undefined ? { recovered: result.recovered } : {}),
        ...(result.recoveredItems !== undefined ? { recoveredItems: result.recoveredItems } : {}),
      };
    });
  },
});
