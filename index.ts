import type {
  CommandHandlerContext,
  ExtensionApi,
  ExtensionModule,
  ImportExportContext,
  PreflightOverrideContext,
} from "@unbrained/pm-cli/sdk/authoring";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import type {
  ItemMetadata,
  BulkItemMutation,
  CommitItemMutationsOptions,
  CommitItemMutationsResult,
  PmClient,
  NotesResult,
} from "@unbrained/pm-cli/sdk";


/**
 * Numeric process exit codes the extension mirrors from the pm SDK contract.
 *
 * The command runtime only treats a thrown error as a cleanly handled non-zero
 * exit when the error carries a numeric `exitCode` property (see
 * `@unbrained/pm-cli` runCommandHandler); a plain `Error` falls through to the
 * "unhandled" path, which RE-INVOKES the handler a second time and exits with a
 * generic code. The SDK constant is mirrored locally rather than imported
 * because standalone-installed extensions load only their own `dist/`, so
 * `@unbrained/pm-cli` is not resolvable at runtime.
 */
export const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

/**
 * Error a command handler throws to exit with a specific, recoverable code.
 *
 * Carries an {@link exitCode} the pm runtime reads to distinguish a handled
 * usage or not-found failure (USAGE, NOT_FOUND) from an unexpected crash
 * (GENERIC_FAILURE), so a bad flag or a missing team reports cleanly instead of
 * surfacing as an unhandled exception that re-invokes the handler.
 */
export class CommandError extends Error {
  /** Numeric code the pm runtime propagates as the process exit status. */
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

/** Typed source-contract failures shared by every Linear HTTP consumer. */
export class LinearSourceRefusal extends CommandError {
  /** Stable category independent of the command that observed malformed data. */
  readonly code = "source_invalid";
  /** Schema-owned field path, never a provider value or operator path. */
  readonly field: string;
  /** Action required before retrying a complete read. */
  readonly remedy: string;
  /** True only when transport failure followed a mutation request. */
  readonly writeUnconfirmed: boolean;
  /** Keep source failures sanitized and recoverable across CLI and SDK boundaries. */
  constructor(field: string, invalidJson = false, writeUnconfirmed = false) {
    const remedy = `Check LINEAR_API_BASE_URL and retry with a complete Linear response matching the documented schema at ${field}; no partial response is authoritative.${writeUnconfirmed ? " Re-read provider and tracker before any retry; a write may already have succeeded." : ""}`;
    super(`${invalidJson ? "Linear request failed: Failed to parse Linear response. " : ""}Linear source refused (source_invalid: ${field}). ${remedy}`, EXIT_CODE.USAGE);
    this.name = "LinearSourceRefusal";
    this.writeUnconfirmed = writeUnconfirmed;
    this.field = field;
    this.remedy = remedy;
  }
}

/** Provider data refused before SDK control-token parsing or any item write. */
export class LinearImportRefusal extends CommandError {
  /** Stable category for values the installed SDK cannot store literally. */
  readonly code = "unrepresentable_value";
  /** Mapped native field whose literal value cannot be safely passed to the SDK. */
  readonly field: string;
  /** Required recovery preserves the provider value instead of silently changing it. */
  readonly remedy: string;
  /** Refuse without echoing provider content or attempting a write. */
  constructor(field: string) {
    const recovery = field === "deadline" ? "Supply Linear's documented literal YYYY-MM-DD calendar date; relative dates and clear tokens cannot be imported as data." : field === "title" ? "Supply a non-empty native title; empty titles cannot be stored literally." : "Preserve the provider value and retry after SDK literal mutation support is available.";
    const remedy = `${recovery} SDK control-token parsing is tracked by pm-cli#1614. Imports never consume stdin. No item writes were attempted.`;
    super(`Linear import refused (unrepresentable_value: ${field}). ${remedy}`, EXIT_CODE.USAGE);
    this.name = "LinearImportRefusal";
    this.field = field;
    this.remedy = remedy;
  }
}

/** Reject SDK control values before either import writer or ownership projection uses a plan. */
function assertLiteralImportValues(plan: Pick<ItemPlan, "title" | "body" | "description" | "assignee" | "deadline">): void {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) throw new LinearImportRefusal("record");
  if (typeof plan.title !== "string" || !plan.title.trim()) throw new LinearImportRefusal("title");
  for (const field of ["body", "description"] as const) {
    if (typeof plan[field] !== "string" || plan[field].trim() === "-") throw new LinearImportRefusal(field);
  }
  for (const field of ["assignee", "deadline"] as const) {
    const value = plan[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || /^(?:none|null)$/i.test(value.trim()))) throw new LinearImportRefusal(field);
  }
  if (plan.deadline !== undefined) {
    const instant = Date.parse(plan.deadline);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.deadline) || !Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== plan.deadline) throw new LinearImportRefusal("deadline");
  }
}

/** Standard host error receipt for source-contract and literal-representability failures. */
export interface LinearSourceErrorReceipt {
  ok: false;
  code: "source_invalid" | "unrepresentable_value";
  field: string;
  remedy: string;
  remediation: string;
  exit_code: typeof EXIT_CODE.USAGE;
  write_unconfirmed?: true;
}

/** Preserve source and literal-value refusals across the host's JSON/TOON and nonzero-exit contract. */
async function withLinearSource<T>(action: () => T | Promise<T>): Promise<T | LinearSourceErrorReceipt> {
  try { return await action(); }
  catch (error: unknown) {
    if (!(error instanceof CommandError) || !("code" in error) || (error.code !== "source_invalid" && error.code !== "unrepresentable_value")) throw error;
    const field = "field" in error && typeof error.field === "string" ? error.field : "issue";
    const remedy = "remedy" in error && typeof error.remedy === "string" ? error.remedy : `Retry a complete provider response at ${field}.`;
    return { ok: false, code: error.code, field, remedy, remediation: remedy, exit_code: EXIT_CODE.USAGE,
      ...("writeUnconfirmed" in error && error.writeUnconfirmed === true ? { write_unconfirmed: true as const } : {}) };
  }
}

/** Apply the shared source-error renderer without changing command metadata or context. */
function registerLinearCommand(api: ExtensionApi, definition: Parameters<ExtensionApi["registerCommand"]>[0] & { run: (ctx: CommandHandlerContext) => unknown }): void {
  const run = definition.run;
  api.registerCommand({ ...definition, run: (ctx) => withLinearSource(() => run(ctx)) });
}

/** Import aliases share the same typed source-error renderer as commands. */
function registerLinearImporter(api: ExtensionApi, name: string, handler: Parameters<ExtensionApi["registerImporter"]>[1]): void {
  api.registerImporter(name, (ctx) => withLinearSource(() => handler(ctx)));
}

/** Export failures retain source diagnostics even when the host renders JSON or TOON. */
function registerLinearExporter(api: ExtensionApi, name: string, handler: Parameters<ExtensionApi["registerExporter"]>[1]): void {
  api.registerExporter(name, (ctx) => withLinearSource(() => handler(ctx)));
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
  name?: string | null;
}

interface LinearAssignee {
  name: string | null;
  email: string | null;
}

/**
 * One Linear issue as the issues query selects it, mirroring the GraphQL nodes.
 *
 * Holds only the fields the importer and exporter read (identifier, title,
 * state, labels, cycle, project, assignee, estimate, dueDate, url) so a change
 * to the selection set is a deliberate edit here rather than a silent shape
 * drift between the fetched payload and the mapped pm item.
 */
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
  cycle?: LinearCycle | null;
  assignee?: LinearAssignee | null;
  project?: { name: string } | null;
  customer?: { name: string } | null;
  url?: string | null;
}

/**
 * One entry of Linear's top-level `errors` array. Linear reports GraphQL
 * failures out-of-band (HTTP 200 + `errors`), so every caller checks this
 * envelope field before trusting `data`; only `message` is ever read.
 */
interface LinearGraphQLError {
  message: string;
}

/**
 * Linear's GraphQL response envelope, generic over the per-operation `data`
 * payload so each call site types exactly the selection set it reads instead
 * of casting the whole response to `any`. `data` is optional AND nullable
 * because the GraphQL spec permits both an omitted `data` field and an explicit
 * `data: null` root payload alongside `errors` — modelling only the omitted case
 * would be unsound for any consumer that reads `data` without optional chaining.
 */
interface LinearResponse<TData> {
  data?: TData | null;
  errors?: LinearGraphQLError[];
}

/**
 * The `data` payload of the paginated issues query: only the connection
 * fields `fetchAllLinearIssues` actually reads while following cursors.
 */
interface LinearIssuesData {
  issues?: {
    nodes: LinearIssue[];
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * The `data` payload of the `viewer { id }` credential probe. Only the
 * viewer id is read: its presence proves the API key is accepted, so the
 * preflight can distinguish "key rejected" from "reachable but unscoped".
 */
interface LinearViewerData {
  viewer?: { id?: string };
}

// Linear's GraphQL API caps `first` at 250 per page; request at most that and
// follow pageInfo.endCursor for the rest.
const LINEAR_MAX_PAGE_SIZE = 250;
/** Shared issue-label read bound for import and ownership acquisition. */
const LINEAR_ISSUE_LABEL_CAP = 128;

// ---------------------------------------------------------------------------
// Option readers — tolerate both kebab-case and camelCase keys.
// The pm CLI normalizes loose extension flags to camelCase (e.g. --dry-run
// arrives as `dryRun`). Reading only the kebab key silently yields undefined,
// which for --dry-run means a "preview" that actually writes. Check both.
// ---------------------------------------------------------------------------

/** Read only an explicitly supplied mapping entry; prototype names are ordinary provider data. */
function ownMappingValue<T>(mapping: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(mapping, key) ? mapping[key] : undefined;
}

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

/**
 * Read a numeric flag value, tolerating both kebab-case and camelCase keys.
 *
 * The pm CLI normalizes loose flags to camelCase, so reading only the kebab key
 * would yield undefined and silently default a `--limit 50` to its fallback.
 * Coerces a numeric string and rejects NaN/Infinity by returning undefined.
 *
 * @param options - Raw flag bag from the command context.
 * @param kebab - The user-facing kebab-case flag name (e.g. `limit`).
 * @returns The parsed finite number, or undefined when the flag is absent.
 */
function readNumberOption(
  options: Record<string, unknown>,
  kebab: string
): number | undefined {
  const v = options[kebab] ?? options[camelKey(kebab)];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read a boolean flag, accepting kebab-case and camelCase plus loose spellings.
 *
 * A bare `--flag` arrives as `true`; `--flag false`, `0`, `no`, and an empty
 * string all collapse to the conventional truthiness a command expects, so a
 * kebab-only read never mis-defaults a boolean switch.
 *
 * @param options - Raw flag bag from the command context.
 * @param kebab - The user-facing kebab-case flag name.
 * @returns The resolved boolean (never undefined; defaults to false).
 */
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

/**
 * Read the `--project-map` flag, preserving the absent-versus-bare distinction.
 *
 * A plain string read would lose the difference between "not passed" and "passed
 * as a bare flag": undefined means the feature is off entirely, the empty string
 * means passthrough (tag with the verbatim project name), and any other value is
 * an explicit `A=x,B=y` remap. Without that split, `--project-map` with no value
 * could be mistaken for "absent" and silently disable project tagging.
 */
function readProjectMapOption(options: Record<string, unknown>): string | undefined {
  const v = options["project-map"] ?? options[camelKey("project-map")];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v ? "" : undefined;
  return typeof v === "string" ? v : String(v);
}

type TeamSource = "flag" | "env";

/**
 * A resolved Linear team slug together with where it came from.
 *
 * The source is carried alongside the value so human and JSON output can explain
 * whether the team came from `--team` or from the `LINEAR_DEFAULT_TEAM` fallback
 * — important for automation where an injected default should be visible, not
 * silent.
 */
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

  if (type === "completed" || type === "canceled" || type === "cancelled" || type === "duplicate") return "closed";
  if (type === "started") return "in_progress";

  // Fallback: match on state name
  if (name.includes("in progress") || name.includes("in review"))
    return "in_progress";
  if (name.includes("blocked")) return "blocked";
  if (name.includes("done") || name.includes("completed")) return "closed";
  if (name.includes("canceled") || name.includes("cancelled")) return "closed";

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
      Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
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

/**
 * Reverse a `--status-map` into a pm-status-keyed lookup for the exporter.
 *
 * The user-facing map is `Linear state name -> pm status` (original casing
 * preserved); the export direction needs the inverse, keyed by pm status, so the
 * same flag round-trips both ways. The original Linear casing survives the flip
 * so the push echoes the state name exactly as authored. First entry wins on a
 * pm-status collision.
 */
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
    if (key && !Object.hasOwn(inverted, key)) Object.defineProperty(inverted, key, { value: linearName, enumerable: true, writable: true, configurable: true });
  }
  return inverted;
}

/**
 * Pick the Linear workflow-state name a pm status should push toward.
 *
 * Prefers a user-supplied inverted status map entry for the status, then falls
 * back to the conventional default names every Linear team ships with ("Todo",
 * "In Progress", "Done"). Returns undefined when neither matches so the caller
 * can leave the issue's current state untouched rather than guessing.
 *
 * @param pmStatus - The pm status string (matched case-insensitively).
 * @param invertedMap - A pm-status-keyed map from `invertStatusMap`.
 * @returns The target Linear state name, or undefined when none resolves.
 */
export function resolveLinearStateName(
  pmStatus: string | undefined,
  invertedMap: Record<string, string>
): string | undefined {
  if (!pmStatus) return undefined;
  const key = pmStatus.trim().toLowerCase();
  return ownMappingValue(invertedMap, key) ?? ownMappingValue(DEFAULT_PM_TO_LINEAR_STATE, key);
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
/**
 * Parsed shape of the `--project-map` flag: whether it is on, its mode, and any
 * explicit remap entries.
 *
 * `enabled` is false only when the flag is absent; `passthrough` tags each item
 * with its own verbatim project name; an explicit `map` remaps matched projects
 * and lets a value of `ignore` suppress a single project's tag.
 */
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
      Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
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
  const override = ownMappingValue(projectMap.map, name.toLowerCase());
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
// assignee, identifier, estimate, cycle, customer.
// ---------------------------------------------------------------------------
export function parseFieldMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const value = pair.slice(idx + 1).trim().toLowerCase();
    if (key && value) Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return map;
}

// True when the Linear field is suppressed via `--map <field>=ignore`. Pure.
export function fieldIsIgnored(
  fieldMap: Record<string, string>,
  linearField: string
): boolean {
  return ownMappingValue(fieldMap, linearField.toLowerCase()) === "ignore";
}

// Resolve the pm target field for a given Linear field, honoring an override.
// Returns the override (unless "ignore"), else the Linear field name itself.
// Pure + exported for testing.
export function resolvePmField(
  fieldMap: Record<string, string>,
  linearField: string
): string {
  const override = ownMappingValue(fieldMap, linearField.toLowerCase());
  if (!override || override === "ignore") return linearField.toLowerCase();
  return override;
}

// ---------------------------------------------------------------------------
// Provenance marker. We can't write registerItemFields custom fields via
// `pm create` from a standalone extension, so encode linear_id + linear_url in
// the item description behind a stable, machine-parseable marker. Pure.
// ---------------------------------------------------------------------------
const PROVENANCE_MARKER = "[linear]";

/**
 * Encode Linear provenance into the stable marker written to a pm description.
 *
 * A standalone extension cannot write registerItemFields custom fields via
 * `pm create`, so the Linear id and url are stored behind a machine-parseable
 * marker that `parseProvenance` reads back to keep re-import idempotent.
 *
 * @param issue - The Linear issue to record (id, identifier, and optional url).
 * @returns The provenance marker string to store in the item description.
 */
export function buildProvenance(issue: {
  id: string;
  identifier: string;
  url?: string | null;
}): string {
  const url = issue.url ?? `https://linear.app/issue/${issue.identifier}`;
  return `${PROVENANCE_MARKER} linear_id=${issue.id} linear_url=${url}`;
}

/**
 * Extract the stored Linear id and url from a pm item's description.
 *
 * Reads back what `buildProvenance` wrote so a re-import can match an existing
 * item by its Linear id and update it instead of creating a duplicate.
 *
 * @param description - The pm item description text to scan.
 * @returns The `{ linear_id, linear_url }` pair, or undefined when absent.
 */
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
/**
 * Toggles for which server-side filter clauses the issues query should include.
 *
 * Each clause is omitted from the query entirely when its flag is false: a
 * `null` or empty filter would match nothing rather than "any", so building the
 * clause only when a value is present keeps an absent filter a true no-op.
 */
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
      labels(first: ${LINEAR_ISSUE_LABEL_CAP}) { nodes { name } pageInfo { hasNextPage } }
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
    const response = await linearRequest<LinearIssuesData>(
      apiKey,
      plan.query,
      plan.variables
    );

    if (response.errors?.length) {
      const msgs = response.errors.map((e) => e.message).join("; ");
      throw new CommandError(`Linear API error: ${msgs}`);
    }

    const invalid = closureInvalidField(response.data, linearIssuesDataShape, "issues");
    if (invalid) throw new LinearSourceRefusal(invalid);
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
// Linear GraphQL client (native Node.js http/https — no external deps)
//
// Robustness: a per-request timeout (default 30s) and exponential backoff retry
// on transient failures (HTTP 429 + 5xx), honoring a Retry-After header when
// present. A retriable HTTP status is surfaced as a RetriableHttpError so the
// retry wrapper can decide; everything else resolves/rejects immediately.
// ---------------------------------------------------------------------------
const DEFAULT_LINEAR_API_BASE_URL = "https://api.linear.app/graphql";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Largest delay Node's timers honour (2^31 - 1 ms); larger values are clamped, not rejected. */
const MAX_TIMER_MS = 2_147_483_647;
const MAX_RETRIES = 4;

interface LinearEndpoint {
  hostname: string;
  port: number;
  path: string;
  useTls: boolean;
}

function linearApiBaseUrl(): string {
  return process.env["LINEAR_API_BASE_URL"] ?? DEFAULT_LINEAR_API_BASE_URL;
}

/** Fixed validation text that is safe to expose without the configured URL. */
const LINEAR_INVALID_ENDPOINT = "LINEAR_API_BASE_URL must be a valid https URL, or an http URL on the loopback host (127.0.0.1, ::1, or localhost).";
/** Fixed transport-policy text; never interpolate endpoint credentials or queries. */
const LINEAR_PROHIBITED_ENDPOINT = "LINEAR_API_BASE_URL must use https, or http only with the loopback host (127.0.0.1, ::1, or localhost).";

/**
 * Resolve the endpoint seam without permitting credentials to leave the host
 * over cleartext HTTP. HTTPS may target any host; HTTP is restricted to exact
 * loopback hostnames for real local GraphQL test servers.
 */
function resolveLinearEndpoint(): LinearEndpoint {
  let url: URL;
  try {
    url = new URL(linearApiBaseUrl());
  } catch {
    throw new Error(
      LINEAR_INVALID_ENDPOINT,
    );
  }
  const useTls = url.protocol === "https:";
  const isHttp = url.protocol === "http:";
  const loopback = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
  if (!useTls && (!isHttp || !loopback.has(url.hostname))) {
    throw new Error(
      LINEAR_PROHIBITED_ENDPOINT,
    );
  }
  return {
    hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port ? Number(url.port) : useTls ? 443 : 80,
    path: url.pathname + url.search,
    useTls,
  };
}

/**
 * Resolve the request timeout from the environment.
 *
 * Only integers from 1 through 2^31-1 ms are accepted; malformed, zero,
 * negative, fractional, and oversized values fall back to the safe 30-second
 * default. Exported because the chosen value is not observable through a
 * request in bounded time (proving a 30 s fallback would take 30 s).
 */
export function resolveRequestTimeoutMs(): number {
  const raw = process.env["LINEAR_REQUEST_TIMEOUT_MS"];
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  const value = Number(raw);
  // Node clamps timers above 2^31-1 ms (about 24.8 days) instead of rejecting
  // them, so an oversized value would silently disable the timeout.
  return Number.isInteger(value) && value > 0 && value <= MAX_TIMER_MS ? value : DEFAULT_REQUEST_TIMEOUT_MS;
}

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

/**
 * Permanent, non-retriable rejection of the supplied credentials (HTTP 401/403).
 *
 * Surfaced as a distinct type rather than a generic request failure because
 * Linear returns these at the HTTP layer — the body is an error JSON, not a
 * GraphQL response — so `linearRequest` maps it to a clear, actionable
 * `CommandError` with a USAGE exit code instead of looping on retries or
 * mis-reporting a parse failure.
 */
export class AuthHttpError extends Error {
  /** HTTP status code Linear returned (401 or 403), surfaced in the message. */
  status: number;
  constructor(status: number) {
    super(`Linear API rejected credentials (HTTP ${status})`);
    this.name = "AuthHttpError";
    this.status = status;
  }
}

/**
 * Compute the backoff delay, in milliseconds, before the next retry attempt.
 *
 * Honors an explicit Retry-After when the server supplied one; otherwise uses an
 * exponential schedule (250ms, 500ms, 1s, 2s…) capped at eight seconds so a
 * sustained outage backs off without unbounded growth.
 *
 * @param attempt - Zero-based retry index (0 is the first retry after the initial failure).
 * @param retryAfterMs - Optional Retry-After value, in milliseconds, to honor directly.
 * @returns The delay to wait before the next attempt.
 */
export function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === "number" && retryAfterMs >= 0) return retryAfterMs;
  // 250ms, 500ms, 1s, 2s … capped at 8s.
  return Math.min(250 * 2 ** attempt, 8_000);
}

/**
 * Interpret a Retry-After response header into a delay in milliseconds.
 *
 * The header may be delta-seconds (`120`) or an HTTP-date; both forms are parsed
 * and normalized to milliseconds from now, so a retry loop never has to special-
 * case the wire format. Returns undefined when the header is absent or gibberish.
 *
 * @param header - The raw `retry-after` header value (string or string array).
 * @returns The delay in milliseconds, or undefined when unparseable.
 */
function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (!header) return undefined;
  const raw = Array.isArray(header) ? header[0] : header;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Send one Linear GraphQL request, with no retry of its own.
 *
 * Enforces a per-request timeout and classifies the HTTP outcome so the retry
 * wrapper can decide: 429 and 5xx reject as a retriable failure, 401/403 reject
 * as a permanent `AuthHttpError`, and everything else resolves the parsed
 * envelope (which may still carry GraphQL `errors`).
 *
 * @param apiKey - The Linear API key sent as the Authorization header.
 * @param query - The GraphQL query document.
 * @param variables - The GraphQL variables for the query.
 * @returns The parsed response envelope.
 */
function linearRequestOnce<TData>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  maxResponseBytes?: number,
): Promise<LinearResponse<TData>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const endpoint = resolveLinearEndpoint();
    const requestOptions = {
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.path,
      method: "POST" as const,
      timeout: resolveRequestTimeoutMs(),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: apiKey,
      },
    };

    const request = endpoint.useTls ? https.request : http.request;
    const req = request(requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        res.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (maxResponseBytes !== undefined && receivedBytes > maxResponseBytes) {
            req.destroy(new Error("Linear response exceeds the declared transport bound"));
          } else chunks.push(chunk);
        });
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
            const envelope: unknown = JSON.parse(raw);
            const invalid = closureInvalidField(envelope, linearEnvelopeShape, "response");
            if (invalid) { reject(new LinearSourceRefusal(invalid, false, /^\s*mutation\b/.test(query))); return; }
            resolve(envelope as LinearResponse<TData>);
          } catch {
            reject(new LinearSourceRefusal("response", true, /^\s*mutation\b/.test(query)));
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

/**
 * Send a Linear GraphQL request with bounded exponential-backoff retry.
 *
 * Retries only transient failures (429 and 5xx, surfaced as RetriableHttpError)
 * up to `MAX_RETRIES` attempts, honoring Retry-After. Permanent auth failures
 * and GraphQL errors are converted into actionable `CommandError` instances with
 * specific exit codes rather than opaque rejections.
 *
 * @param apiKey - The Linear API key sent as the Authorization header.
 * @param query - The GraphQL query document.
 * @param variables - The GraphQL variables for the query.
 * @returns The parsed response envelope.
 */
async function linearRequest<TData>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<LinearResponse<TData>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await linearRequestOnce<TData>(apiKey, query, variables);
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
  if (lastErr instanceof LinearSourceRefusal) throw lastErr;
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

const COMPLETE_READ_RECOVERY =
  "Upgrade @unbrained/pm-cli to >=2026.10.4, repair any unreadable tracker items, " +
  "and retry with listAllComplete({ includeBody: true }); diagnostic CLI: " +
  "pm list --all --full --include-body --strict-read --no-truncate " +
  "--output-budget unbounded --output-limit unbounded --json.";

/**
 * Load the runtime SDK lazily. Module load keeps `@unbrained/pm-cli` a
 * type-only edge (see the file header), so a missing peer surfaces as a
 * CommandError from the reader instead of a failed extension import.
 */
const importRuntimeSdk = (): Promise<typeof import("@unbrained/pm-cli/sdk/runtime")> => import("@unbrained/pm-cli/sdk/runtime");

/**
 * Certify a whole-tracker SDK answer and validate the fields consumed by Linear.
 *
 * The public SDK validator checks source, projection, pagination and omission
 * receipts. Its certificate covers row identities, so this boundary additionally
 * requires bodies and well-typed matching/export fields. It validates the entire
 * corpus before returning even one row to a mutation planner.
 *
 * @param candidate - Untrusted complete-read envelope, including its certificate.
 * @returns Full items only after every completeness and row check succeeds.
 */
export async function certifyPmItems(candidate: unknown): Promise<PmItem[]> {
  try {
    const sdk = await importRuntimeSdk();
    const result = sdk.certifyCompleteListResult(candidate);
    const certificate = (candidate as Record<string, unknown>).complete_list;
    if (typeof certificate !== "object" || certificate === null || Array.isArray(certificate)) {
      throw new Error("missing or malformed complete_list certificate");
    }
    const proof = certificate as Record<string, unknown>;
    for (const [key, value] of Object.entries(result.complete_list)) {
      if (proof[key] !== value) throw new Error(`invalid complete_list certificate: ${key}`);
    }
    if (result.filters?.include_body !== true) throw new Error("body projection unproven");
    for (const [index, item] of result.items.entries()) {
      const row = item as unknown as Record<string, unknown>;
      const requiredStrings = ["id", "title", "status"];
      const optionalStrings = ["description", "deadline"];
      if (requiredStrings.some((key) => typeof row[key] !== "string" || !row[key].trim()) ||
          typeof row.body !== "string" ||
          optionalStrings.some((key) => row[key] !== undefined && typeof row[key] !== "string") ||
          (row.priority !== undefined &&
            (!Number.isInteger(row.priority) || Number(row.priority) < 0 || Number(row.priority) > 4)) ||
          (row.tags !== undefined &&
            (!Array.isArray(row.tags) || row.tags.some((tag: unknown) => typeof tag !== "string")))) {
        throw new Error(`malformed local item row ${index + 1}`);
      }
    }
    return result.items;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Complete local item read refused: ${message}. ${COMPLETE_READ_RECOVERY}`);
  }
}

/**
 * Read every local item in-process, including terminal work and complete bodies.
 *
 * Disables extension discovery so this observational read cannot invoke hooks or
 * recursively re-enter this extension. Lazy loading preserves command discovery
 * when an old or standalone host cannot resolve the SDK, but reading fails with
 * an actionable CommandError. There is no bounded subprocess fallback.
 *
 * @param pmRoot - Explicit tracker root supplied by the command runtime.
 * @returns A certified whole corpus, never a page or an empty fallback.
 */
async function readPmItems(pmRoot: string): Promise<PmItem[]> {
  try {
    const sdk = await importRuntimeSdk();
    const result = await sdk.listAllComplete(
      { includeBody: true },
      { pmRoot, noExtensions: true },
    );
    return await certifyPmItems(result);
  } catch (err: unknown) {
    if (err instanceof CommandError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Complete local item read refused: ${message}. ${COMPLETE_READ_RECOVERY}`);
  }
}

/** Versioned, read-only mapping negotiation inputs shared by sync and agents. */
export interface LinearSchemaOptions {
  team: string;
  statusMap?: Record<string, string>;
  /** Opaque version returned by a previous negotiation; changes refuse apply. */
  schemaVersion?: string;
}

/** Stable refusal categories; callers can recover without parsing prose. */
export type LinearSchemaRefusalCode =
  | "access_denied" | "schema_unavailable" | "metadata_incomplete"
  | "mapping_invalid" | "schema_drift";

/** Compact compatibility evidence; no issue bodies or credentials are returned. */
export interface LinearSchemaReport {
  formatVersion: 1;
  compatible: true;
  schemaVersion: string;
  team: string;
  teamId: string;
  settings: { cyclesEnabled: boolean; triageEnabled: boolean; issueEstimationType: string; defaultStateId: string | null };
  counts: { states: number; labels: number; localStatuses: number };
  /** First 32 mappings; negotiation and versioning always cover every state. */
  states: Array<{ id: string; name: string; type: string; status: string }>;
  omittedStates: number;
  labels: { policy: "name_to_tag"; digest: string };
}

/** Handled refusal with a machine-readable code, remedy and optional fresh report. */
export class LinearSchemaRefusal extends CommandError {
  /** Stable category suitable for agent branching. */
  readonly code: LinearSchemaRefusalCode;
  /** Recovery action safe to show in CLI and SDK output. */
  readonly remedy: string;
  /** Fresh negotiation when an old version was invalidated. */
  readonly report?: LinearSchemaReport;
  constructor(code: LinearSchemaRefusalCode, remedy: string, report?: LinearSchemaReport) {
    super(`Linear schema refused (${code}). ${remedy}`, EXIT_CODE.USAGE);
    this.name = "LinearSchemaRefusal";
    this.code = code;
    this.remedy = remedy;
    this.report = report;
  }
}

/** Metadata queries include workspace labels and paginate both connections independently. */
const SCHEMA_QUERY = `query LinearSchema($key: String!, $statesAfter: String, $labelsAfter: String) {
  teams(filter: {key: {eq: $key}}, first: 2) {
    nodes {
      id key cyclesEnabled triageEnabled issueEstimationType defaultIssueState { id }
      states(first: 250, after: $statesAfter) { nodes { id name type } pageInfo { hasNextPage endCursor } }
    }
  }
  issueLabels(first: 250, after: $labelsAfter, filter: {or: [{team: {key: {eq: $key}}}, {team: {null: true}}]}) {
    nodes { id name } pageInfo { hasNextPage endCursor }
  }
}`;

/** Narrow the untrusted GraphQL JSON object before using a field. */
function schemaObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LinearSchemaRefusal("metadata_incomplete", "Restore full team metadata read access and retry linear schema.");
  }
  return value as Record<string, unknown>;
}

/** Require a nonempty metadata identifier or name instead of hashing missing fields. */
function schemaString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LinearSchemaRefusal("metadata_incomplete", "Restore complete team states, labels and settings, then retry linear schema.");
  }
  return value;
}

/** Hash canonical, sorted metadata; the format prefix makes future migrations explicit. */
function schemaDigest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Validate a connection and reject truncated pages or a non-advancing cursor. */
function schemaPage(value: unknown, seen: Set<string>): { rows: Record<string, unknown>[]; next: string | null } {
  const connection = schemaObject(value);
  const page = schemaObject(connection.pageInfo);
  if (!Array.isArray(connection.nodes) || typeof page.hasNextPage !== "boolean" ||
      !(page.endCursor === null || typeof page.endCursor === "string")) {
    throw new LinearSchemaRefusal("metadata_incomplete", "Retry with complete paginated metadata responses.");
  }
  let next: string | null = null;
  if (page.hasNextPage) {
    next = schemaString(page.endCursor);
    if (seen.has(next) || connection.nodes.length === 0) {
      throw new LinearSchemaRefusal("metadata_incomplete", "Retry metadata discovery; pagination did not advance.");
    }
    seen.add(next);
  }
  return { rows: connection.nodes.map(schemaObject), next };
}

/** Order digest inputs by UTF-16 code units, independent of host locale and ICU. */
function compareSchemaKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Read local lifecycle definitions through the SDK, suppressing filesystem details on failure. */
async function readSchemaStatuses(pmRoot: string) {
  try {
    const sdk = await importRuntimeSdk();
    const local = await sdk.schemaList({ pmRoot, noExtensions: true });
    const settings = await sdk.readSettings(sdk.resolvePmRoot(process.cwd(), pmRoot));
    const registry = sdk.resolveRuntimeStatusRegistry(settings.schema);
    return { statuses: [...local.statuses.builtin, ...local.statuses.custom].sort((a, b) => compareSchemaKeys(a.id, b.id)),
      normalize: (value: string) => sdk.normalizeStatusInput(value, registry) };
  } catch {
    throw new LinearSchemaRefusal("schema_unavailable", "Repair the local tracker schema or upgrade the resolvable pm SDK, then retry linear schema.");
  }
}

/**
 * Discover current Linear states, labels and settings and negotiate local statuses.
 * Uses the public pm schema SDK and the existing retrying HTTP client. No git,
 * tracker writes or Linear mutations are involved. Versions bind stable IDs,
 * exact names, team settings, local status definitions and explicit overrides.
 * A stale version always fails closed, even when a rename maps to the same pm status.
 */
export async function negotiateLinearSchema(
  options: LinearSchemaOptions,
  pmRoot: string,
): Promise<LinearSchemaReport> {
  const apiKey = process.env["LINEAR_API_KEY"];
  if (!apiKey) throw new LinearSchemaRefusal("access_denied", "Set LINEAR_API_KEY with Read access to the target team, then retry linear schema.");
  const localStatuses = await readSchemaStatuses(pmRoot);
  const statuses = localStatuses.statuses;
  const stateRows = new Map<string, { id: string; name: string; type: string }>();
  const labelRows = new Map<string, { id: string; name: string }>();
  const stateCursors = new Set<string>();
  const labelCursors = new Set<string>();
  let statesAfter: string | null = null;
  let labelsAfter: string | null = null;
  let statesDone = false;
  let labelsDone = false;
  let teamId = "";
  let team = "";
  let settings: LinearSchemaReport["settings"] | undefined;
  for (let pageCount = 0; ; pageCount++) {
    if (pageCount >= 1000) throw new LinearSchemaRefusal("metadata_incomplete", "Reduce metadata size or retry after provider pagination stabilizes.");
    let response: LinearResponse<unknown>;
    try {
      response = await linearRequest<unknown>(apiKey, SCHEMA_QUERY, {
        key: options.team.trim().toUpperCase(), statesAfter, labelsAfter,
      });
    } catch (error: unknown) {
      if (error instanceof LinearSourceRefusal) throw error;
      const denied = error instanceof CommandError && /rejected the API key/.test(error.message);
      // Only our fixed endpoint-validation messages may cross this boundary.
      // Other request errors can contain configured paths, queries or secrets.
      const endpointCause = error instanceof CommandError
        ? [LINEAR_INVALID_ENDPOINT, LINEAR_PROHIBITED_ENDPOINT].find(
          (message) => error.message === `Linear request failed: ${message}`,
        )
        : undefined;
      throw new LinearSchemaRefusal(denied ? "access_denied" : "schema_unavailable",
        denied ? "Restore Read permission for the target team and retry linear schema."
          : "Check Linear connectivity and LINEAR_API_BASE_URL, then retry linear schema; no local changes were made." +
            (endpointCause ? ` Cause: ${endpointCause}` : ""));
    }
    if (response.errors?.length) {
      throw new LinearSchemaRefusal("access_denied", "Restore access to team settings, workflow states and labels; check API schema support, then retry linear schema.");
    }
    const data = schemaObject(response.data);
    const teams = schemaObject(data.teams);
    if (!Array.isArray(teams.nodes) || teams.nodes.length !== 1) {
      throw new LinearSchemaRefusal("access_denied", "Check the team key and grant the API key Read access to that team, then retry linear schema.");
    }
    const node = schemaObject(teams.nodes[0]);
    const nextTeamId = schemaString(node.id);
    const nextTeam = schemaString(node.key);
    if (nextTeam !== options.team.trim().toUpperCase() ||
        typeof node.cyclesEnabled !== "boolean" || typeof node.triageEnabled !== "boolean") {
      throw new LinearSchemaRefusal("metadata_incomplete", "Retry with full settings for the requested team.");
    }
    const nextSettings = {
      cyclesEnabled: node.cyclesEnabled, triageEnabled: node.triageEnabled,
      issueEstimationType: schemaString(node.issueEstimationType),
      defaultStateId: node.defaultIssueState === null ? null : schemaString(schemaObject(node.defaultIssueState).id),
    };
    if (settings && (teamId !== nextTeamId || JSON.stringify(settings) !== JSON.stringify(nextSettings))) {
      throw new LinearSchemaRefusal("schema_drift", "Team settings changed during discovery. Retry linear schema.");
    }
    teamId = nextTeamId;
    team = nextTeam;
    settings = nextSettings;
    if (!statesDone) {
      const page = schemaPage(node.states, stateCursors);
      for (const row of page.rows) {
        const id = schemaString(row.id);
        if (stateRows.has(id)) throw new LinearSchemaRefusal("metadata_incomplete", "Retry discovery; duplicate workflow state IDs were returned.");
        stateRows.set(id, { id, name: schemaString(row.name), type: schemaString(row.type) });
      }
      statesAfter = page.next;
      statesDone = statesAfter === null;
    }
    if (!labelsDone) {
      const page = schemaPage(data.issueLabels, labelCursors);
      for (const row of page.rows) {
        const id = schemaString(row.id);
        if (labelRows.has(id)) throw new LinearSchemaRefusal("metadata_incomplete", "Retry discovery; duplicate label IDs were returned.");
        labelRows.set(id, { id, name: schemaString(row.name) });
      }
      labelsAfter = page.next;
      labelsDone = labelsAfter === null;
    }
    if (statesDone && labelsDone) break;
  }
  const states = [...stateRows.values()].sort((a, b) => compareSchemaKeys(a.id, b.id));
  const labels = [...labelRows.values()].sort((a, b) => compareSchemaKeys(a.id, b.id));
  const overrides = Object.entries(options.statusMap ?? {}).map(([name, status]) => [name.trim().toLowerCase(), localStatuses.normalize(status) ?? status] as const).sort(([a], [b]) => compareSchemaKeys(a, b));
  if (!states.length || new Set(overrides.map(([name]) => name)).size !== overrides.length ||
      overrides.some(([name, status]) => !states.some((state) => state.name.toLowerCase() === name) || !statuses.some((s) => s.id === status))) {
    throw new LinearSchemaRefusal("mapping_invalid", "Remove stale state overrides and map each workflow state to a registered pm status using --status-map.");
  }
  const mappings = states.map((state) => ({ ...state, status: resolveStatus(state.type, state.name, Object.fromEntries(overrides)) }));
  const schemaVersion = `linear-schema-v1:${schemaDigest({ teamId, team, settings, states, labels, statuses, overrides, mappings })}`;
  const report: LinearSchemaReport = {
    formatVersion: 1, compatible: true, schemaVersion, team, teamId, settings,
    counts: { states: states.length, labels: labels.length, localStatuses: statuses.length },
    states: mappings.slice(0, 32), omittedStates: Math.max(0, mappings.length - 32), labels: { policy: "name_to_tag", digest: schemaDigest(labels) },
  };
  if (options.schemaVersion !== undefined && options.schemaVersion !== schemaVersion) {
    throw new LinearSchemaRefusal("schema_drift", "Run linear schema again, review the new mapping and retry with its --schema-version.", report);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Core sync logic — shared between command and importer
// ---------------------------------------------------------------------------
/** Recoverable capture failures; messages never include provider responses or tracker paths. */
export type ThreadCaptureRefusalCode = "selection_required" | "access_denied" | "source_incomplete" | "source_changed" | "target_unavailable" | "review_required" | "budget_exceeded" | "write_unconfirmed";

/** Machine-readable refusal with a safe, concrete next action. */
export class ThreadCaptureRefusal extends CommandError {
  /** Stable failure category for SDK consumers. */
  readonly code: ThreadCaptureRefusalCode;
  /** Recovery instruction safe to print in an agent transcript. */
  readonly remedy: string;
  constructor(code: ThreadCaptureRefusalCode, remedy: string) {
    super(`Linear thread capture refused (${code}). ${remedy}`, EXIT_CODE.USAGE);
    this.name = "ThreadCaptureRefusal";
    this.code = code;
    this.remedy = remedy;
  }
}

/** Explicit root selection and existing target; text disclosure and writes require separate opt-ins. */
export interface ThreadCaptureOptions {
  threadId: string;
  itemId: string;
  disclosure?: "metadata" | "text";
  apply?: boolean;
  /** Token from a reviewed preview, binding source, tracker, target and disclosure. */
  revision?: string;
  /** Complete receipt budget, default 8192 bytes; never silently truncates evidence. */
  maxOutputBytes?: number;
}

/** One attributed observation; names and body exist only in text disclosure mode. */
export interface ThreadEvidenceComment {
  id: string;
  updatedAt: string;
  author: { kind: "user" | "external" | "unknown"; id: string | null; nameDigest: string | null; name?: string };
  bodyDigest: string;
  body?: string;
}

/** Immutable core context event; provider attribution remains distinct from the importing author. */
export interface ThreadEvidenceNote {
  type: "linear.thread-evidence.v1";
  threadId: string;
  url: string;
  sourceRevision: string;
  disclosure: "metadata" | "text";
  comments: ThreadEvidenceComment[];
}

/** Bounded proposal or delivery receipt, suitable for native TOON and JSON rendering. */
export interface ThreadCaptureReport {
  formatVersion: 1;
  mode: "plan" | "apply";
  itemId: string;
  revision: string;
  sourceChanged: boolean;
  previousSourceRevision: string | null;
  duplicate: boolean;
  appended: number;
  commentCount: number;
  proposedNote: ThreadEvidenceNote;
}

/** Select one root and only its direct replies; never enumerate issues or workspace comments. */
const THREAD_QUERY = `query LinearThreadCapture($id: String!, $after: String) {
  comment(id: $id) {
    id parentId url updatedAt body user { id name } externalUser { id name }
    children(first: 100, after: $after, includeArchived: true) {
      nodes { id parentId updatedAt body user { id name } externalUser { id name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Reject malformed wire objects without reflecting private response values. */
function threadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThreadCaptureRefusal("source_incomplete", "Retry with complete Linear comment read access; no evidence was written.");
  }
  return value as Record<string, unknown>;
}

/** Require bounded provider strings, retaining exact content for revision hashing. */
function threadString(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) {
    throw new ThreadCaptureRefusal("source_incomplete", "Retry with complete, bounded comment IDs, timestamps and attribution.");
  }
  return value;
}

/** Validate and project a comment without requesting emails, attachments or generated summaries. */
function threadComment(row: Record<string, unknown>, disclosure: "metadata" | "text"): ThreadEvidenceComment {
  const id = threadString(row.id);
  const updatedAt = threadString(row.updatedAt);
  if (!Number.isFinite(Date.parse(updatedAt)) || typeof row.body !== "string" || Buffer.byteLength(row.body) > 65536 ||
      row.user === undefined || row.externalUser === undefined) {
    throw new ThreadCaptureRefusal("source_incomplete", "Retry after restoring complete comment bodies, timestamps and nullable author fields.");
  }
  const actor = row.externalUser ?? row.user;
  const author: ThreadEvidenceComment["author"] = actor === null
    ? { kind: "unknown", id: null, nameDigest: null }
    : { kind: row.externalUser === null ? "user" : "external", id: threadString(threadObject(actor).id), nameDigest: schemaDigest(threadString(threadObject(actor).name)) };
  if (disclosure === "text" && actor !== null) author.name = threadString(threadObject(actor).name);
  return { id, updatedAt, author, bodyDigest: schemaDigest(row.body), ...(disclosure === "text" ? { body: row.body } : {}) };
}

/** Read and validate every selected reply page before constructing a proposal. */
async function readThreadEvidence(threadId: string, disclosure: "metadata" | "text"): Promise<ThreadEvidenceNote> {
  const key = process.env["LINEAR_API_KEY"];
  if (!key) throw new ThreadCaptureRefusal("access_denied", "Set LINEAR_API_KEY with Read access to the explicitly selected thread and retry.");
  const comments = new Map<string, ThreadEvidenceComment>();
  const cursors = new Set<string>();
  let after: string | null = null;
  let rootRevision = "";
  let url = "";
  for (let page = 0; ; page++) {
    let response: LinearResponse<unknown>;
    try { response = await linearRequest<unknown>(key, THREAD_QUERY, { id: threadId, after }); }
    catch (error: unknown) { if (error instanceof LinearSourceRefusal) throw error; throw new ThreadCaptureRefusal("access_denied", "Check Linear connectivity, endpoint and Read permission for the selected thread, then retry."); }
    if (response.errors?.length) throw new ThreadCaptureRefusal("access_denied", "Restore complete thread read access and verify Linear schema support, then retry.");
    const root = threadObject(threadObject(response.data).comment);
    if (root.id !== threadId || root.parentId !== null) {
      throw new ThreadCaptureRefusal("selection_required", "Select the exact top-level Linear comment ID; replies cannot implicitly select their parent.");
    }
    const rootComment = threadComment(root, disclosure);
    const nextUrl = threadString(root.url, 2048);
    if (!/^https:\/\/linear\.app\/[^\s?#]+(?:#[^\s]*)?$/.test(nextUrl)) {
      throw new ThreadCaptureRefusal("source_incomplete", "Retry with a canonical HTTPS Linear comment URL without query parameters.");
    }
    const fingerprint = schemaDigest({ rootComment, url: nextUrl });
    if (page && rootRevision !== fingerprint) throw new ThreadCaptureRefusal("source_changed", "The root changed while paging. Preview the selected thread again before applying.");
    rootRevision = fingerprint;
    url = nextUrl;
    comments.set(threadId, rootComment);
    const connection = threadObject(root.children);
    const info = threadObject(connection.pageInfo);
    if (!Array.isArray(connection.nodes) || typeof info.hasNextPage !== "boolean" ||
        !(info.endCursor === null || typeof info.endCursor === "string")) {
      throw new ThreadCaptureRefusal("source_incomplete", "Retry with complete reply pagination; partial threads cannot become evidence notes.");
    }
    for (const value of connection.nodes) {
      const row = threadObject(value);
      const comment = threadComment(row, disclosure);
      if (row.parentId !== threadId || comments.has(comment.id)) {
        throw new ThreadCaptureRefusal("source_incomplete", "Retry after duplicate or unrelated replies disappear from the selected thread response.");
      }
      comments.set(comment.id, comment);
    }
    if (comments.size > 100) throw new ThreadCaptureRefusal("budget_exceeded", "Select a thread with at most 100 comments; nothing was truncated or written.");
    if (!info.hasNextPage) break;
    const cursor = threadString(info.endCursor);
    if (!connection.nodes.length || cursors.has(cursor)) throw new ThreadCaptureRefusal("source_incomplete", "Retry when Linear reply pagination advances; no partial capture is accepted.");
    cursors.add(cursor);
    after = cursor;
  }
  const rows = [...comments.values()].sort((a, b) => compareSchemaKeys(a.id, b.id));
  // Revision identity is independent of disclosure; digests expose edits while
  // keeping comment bodies and display names out of metadata proposals.
  const sourceRevision = schemaDigest({ threadId, url, comments: rows.map(({ body: _body, author: { name: _name, ...author }, ...row }) => ({ ...row, author })) });
  return { type: "linear.thread-evidence.v1", threadId, url, sourceRevision, disclosure, comments: rows };
}

/**
 * Preview an explicit Linear thread, or append its reviewed revision to an existing item.
 * Uses native SDK structured notes, append-only history and lock-scoped ifAbsent.
 * Re-fetches the complete selected thread to detect observable paging drift; no
 * provider snapshot transaction is claimed. No item creation or git is involved.
 */
export async function captureLinearThread(options: ThreadCaptureOptions, pmRoot: string): Promise<ThreadCaptureReport> {
  const disclosure = options.disclosure ?? "metadata";
  const budget = options.maxOutputBytes ?? 8192;
  if (typeof options.threadId !== "string" || typeof options.itemId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(options.threadId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.itemId) ||
      !["metadata", "text"].includes(disclosure) || (options.apply !== undefined && typeof options.apply !== "boolean")) {
    throw new ThreadCaptureRefusal("selection_required", "Pass an explicit --thread root ID and existing --item ID; choose --disclosure metadata or text.");
  }
  if (!Number.isInteger(budget) || budget < 1024 || budget > 65536) throw new ThreadCaptureRefusal("budget_exceeded", "Set --max-output-bytes to an integer from 1024 through 65536.");
  if (options.apply && !options.revision) throw new ThreadCaptureRefusal("review_required", "Preview first, review the target and disclosure, then pass --apply --revision with that preview token.");
  let pm: PmClient;
  let existing: NotesResult;
  let trackerIdentity: string;
  try {
    const sdk = await importRuntimeSdk();
    const canonicalRoot = await realpath(sdk.resolvePmRoot(process.cwd(), pmRoot));
    const settings = await sdk.readSettings(canonicalRoot);
    trackerIdentity = schemaDigest({ root: canonicalRoot, idPrefix: settings.id_prefix });
    pm = new sdk.PmClient({ pmRoot: canonicalRoot, noExtensions: true, author: "pm-linear" });
    const result = await pm.notes(options.itemId, { eventType: "linear.thread-evidence.v1", includeMeta: true, outputBudget: "unbounded", outputLimit: "unbounded" });
    if (!("notes" in result) || result.has_more || result.total_count !== result.notes.length) throw new Error("Incomplete note history");
    existing = result;
  } catch { throw new ThreadCaptureRefusal("target_unavailable", "Select an existing readable pm item; capture never creates items. Restore complete notes access and retry."); }
  const note = await readThreadEvidence(options.threadId, disclosure);
  const verified = await readThreadEvidence(options.threadId, disclosure);
  if (schemaDigest(note) !== schemaDigest(verified)) throw new ThreadCaptureRefusal("source_changed", "The discussion changed during capture. Preview again and review the fresh revision.");
  const revision = `linear-capture-v1:${schemaDigest({ trackerIdentity, itemId: existing.id, note })}`;
  if (options.revision !== undefined && options.revision !== revision) throw new ThreadCaptureRefusal("source_changed", "Source, tracker, target or disclosure changed. Preview again and use the newly reviewed --revision token.");
  const previous = existing.notes.filter((entry) => entry.author === "pm-linear" && entry.event_type === note.type)
    .map((entry) => threadObject(entry.data)).filter((entry) => entry.threadId === note.threadId);
  const last = previous.at(-1);
  const previousSourceRevision = last ? last.sourceRevision : null;
  if (previousSourceRevision !== null && (typeof previousSourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(previousSourceRevision))) {
    throw new ThreadCaptureRefusal("target_unavailable", "The target contains an invalid capture revision. Preserve its history and select another existing target or restore valid capture metadata through supported PM tooling.");
  }
  const report: ThreadCaptureReport = {
    formatVersion: 1, mode: options.apply ? "apply" : "plan", itemId: existing.id, revision,
    sourceChanged: previousSourceRevision !== null && previousSourceRevision !== note.sourceRevision,
    previousSourceRevision, duplicate: previous.some((entry) => entry.sourceRevision === note.sourceRevision && entry.disclosure === note.disclosure),
    appended: 0, commentCount: note.comments.length, proposedNote: note,
  };
  // Reserve bytes for the largest post-write receipt before making a mutation.
  if (Buffer.byteLength(JSON.stringify({ ...report, appended: 1 })) + 256 > budget) {
    throw new ThreadCaptureRefusal("budget_exceeded", "Use metadata disclosure or raise --max-output-bytes up to 65536; the complete proposal must fit before writing.");
  }
  if (options.apply) {
    try {
      const result = await pm.notes(existing.id, { addJson: JSON.stringify(note), ifAbsent: true, author: "pm-linear" });
      if (typeof result.changed !== "boolean") throw new Error("Missing write acknowledgement");
      report.appended = result.changed ? 1 : 0;
      report.duplicate = !result.changed;
    } catch { throw new ThreadCaptureRefusal("write_unconfirmed", "Delivery may have persisted. Restore tracker access or ownership, then retry the identical selection, disclosure and revision; SDK deduplication prevents a second note."); }
  }
  return report;
}

/** Native import fields compared after the SDK canonicalizes both sides. */
export const LINEAR_OWNERSHIP_FIELDS = Object.freeze(["title", "body", "status", "priority", "tags", "deadline", "assignee", "description"] as const);
/** A field owned by the Linear import mapping, including derived cycle/estimate/customer tags. */
export type LinearOwnershipField = typeof LINEAR_OWNERSHIP_FIELDS[number];
/** Content digests avoid disclosing field text in agent plans. */
export interface LinearOwnershipSnapshot {
  format: "pm-linear/ownership/1";
  localId: string;
  linearId: string;
  mapping: string;
  localRevision: string;
  providerRevision: string;
  fields: Array<{ field: LinearOwnershipField; local: string; provider: string }>;
}
/** Explicit selection, optional operator-acknowledged observation, and hard output budget. */
export interface LinearOwnershipOptions {
  item: string;
  base?: LinearOwnershipSnapshot;
  statusMap?: Record<string, string>;
  maxOutputBytes?: number;
}
/** Stable ownership outcomes; no outcome authorizes a write. */
export type LinearOwnershipDecision = "unchanged" | "aligned" | "local_edit" | "provider_edit" | "conflict" | "unknown_base";
/** Read-only field plan and reusable observation. Saving it does not acknowledge or sync anything. */
export interface LinearOwnershipReport {
  ok: true;
  mode: "preview";
  atomicCrossSystem: false;
  guarantee: string;
  base: "acknowledged" | "missing" | "foreign";
  disjoint: boolean;
  fields: Array<{ field: LinearOwnershipField; decision: LinearOwnershipDecision }>;
  counts: { local: number; provider: number; conflicts: number; unknown: number };
  observation: LinearOwnershipSnapshot;
  remedy: string;
}
/** Typed, sanitized refusals for callers that must decide whether and how to retry. */
export class LinearOwnershipRefusal extends CommandError {
  /** Stable refusal category for agent branching. */
  readonly code: "invalid_input" | "local_read_failed" | "selection_required" | "source_invalid" | "source_changed" | "access_denied" | "output_budget";
  /** Required recovery step before retrying. */
  readonly remedy: string;
  /** Schema-owned field coordinate when source validation fails. */
  readonly field?: string;
  constructor(code: LinearOwnershipRefusal["code"], remedy: string, field?: string) {
    super(`Linear ownership refused (${code}). ${remedy}`, EXIT_CODE.USAGE);
    this.name = "LinearOwnershipRefusal";
    this.field = field;
    this.code = code;
    this.remedy = remedy;
  }
}

/**
 * Observe one linked issue and compare paired acknowledged field hashes with fresh values.
 * Uses isolated complete SDK reads and canonicalDocument, plus the exact import projection.
 * This is context only: there is no apply, saved journal, retry write, or atomic guarantee.
 */
export async function previewLinearOwnership(options: LinearOwnershipOptions, pmRoot: string): Promise<LinearOwnershipReport> {
  if (!closureMatches(options, ownershipOptionsShape)) throw new LinearOwnershipRefusal("invalid_input", "Select one existing linked item, remove unknown options, and use an integer byte budget from 2048 through 65536.");
  const budget = options.maxOutputBytes ?? 8192;
  let sdk: Awaited<ReturnType<typeof importRuntimeSdk>>;
  let source: string;
  let view: ClosureReadView;
  try {
    sdk = await importRuntimeSdk();
    source = await realpath(sdk.resolvePmRoot(process.cwd(), pmRoot));
    view = await readClosureItems(source, [options.item]);
  } catch { throw new LinearOwnershipRefusal("local_read_failed", "Restore a readable initialized tracker and a compatible pm SDK, then retry the complete isolated read."); }
  const local = view.items.find((item) => item.id === view.selectedIds[0]);
  const linearId = parseProvenance(local?.description)?.linear_id;
  if (!local || !linearId || !closureMatches(linearId, closureId) || view.items.filter((item) => parseProvenance(item.description)?.linear_id === linearId).length !== 1) {
    throw new LinearOwnershipRefusal("selection_required", "Select one existing item with unique Linear provenance; repair ambiguous links through supported pm tooling first.");
  }
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new LinearOwnershipRefusal("access_denied", "Set LINEAR_API_KEY with read access to the selected issue, then retry.");
  /** Reuse the bounded HTTP transport without retrying an observational acquisition. */
  async function observe(): Promise<LinearIssue & { updatedAt: string }> {
    let response: LinearResponse<{ issue?: unknown }>;
    try { response = await linearRequestOnce(key!, OWNERSHIP_QUERY, { id: linearId }, 131072); }
    catch (error: unknown) {
      if (error instanceof LinearSourceRefusal) throw new LinearOwnershipRefusal(error.code, error.remedy, error.field);
      throw new LinearOwnershipRefusal("access_denied", "Restore Linear read access and connectivity; no writes were attempted.");
    }
    if (response.errors?.length) throw new LinearOwnershipRefusal("access_denied", "Restore permission to read every selected issue field and retry; provider error text is withheld.");
    const issue = response.data?.issue;
    const invalid = closureInvalidField(issue, ownershipIssueShape, "issue");
    if (invalid || (issue as LinearIssue).id !== linearId) {
      const field = invalid ?? "issue.id";
      throw new LinearOwnershipRefusal("source_invalid", `Retry with a complete issue response matching the documented domain at ${field}.`, field);
    }
    return issue as LinearIssue & { updatedAt: string };
  }
  const issue = await observe();
  const registry = sdk.resolveRuntimeStatusRegistry(view.settings.schema);
  const normalizedMap = new Map<string, string>();
  for (const [name, value] of Object.entries(options.statusMap ?? {})) {
    const target = sdk.normalizeStatusInput(value, registry);
    const key = name.trim().toLowerCase();
    if (!key || !target || normalizedMap.has(key)) throw new LinearOwnershipRefusal("invalid_input", "Use unambiguous state mappings to statuses in the configured SDK registry.");
    normalizedMap.set(key, target);
  }
  const mapping = schemaDigest({ projection: "linear-import-v3-sdk-projection", configuration: view.configuration, statusMap: [...normalizedMap].sort(([a], [b]) => compareSchemaKeys(a, b)) });
  const plan = buildItemPlan(issue, Object.fromEntries(normalizedMap));
  /** The same SDK canonicalizer used by persistence handles status aliases and metadata. */
  function project(item: PmItem): Map<LinearOwnershipField, string> {
    const document = sdk.canonicalDocument({ metadata: { id: local!.id!, type: "Task", title: "", status: "open", created_at: "", updated_at: "", description: "", ...item } as ItemMetadata, body: item.body ?? "" }, { schema: view.settings.schema });
    const metadata = document.metadata as unknown as Record<string, unknown>;
    return new Map(LINEAR_OWNERSHIP_FIELDS.map((field) => [field, schemaDigest(field === "body" ? document.body : metadata[field] ?? null)]));
  }
  // Execute the exact writer rows through the SDK in an owned disposable copy.
  // Persistence canonicalization alone does not cover SDK option parsing or
  // lifecycle effects (for example, canceled-role assignment clearing).
  let projection: ClosureReadView;
  try { projection = await readClosureItems(source, [options.item], { ...plan, identifier: issue.identifier, linearId, match: local }); }
  catch (error: unknown) {
    if (error instanceof LinearImportRefusal) throw error;
    throw new LinearOwnershipRefusal("invalid_input", "The SDK could not project this import against an isolated copy. Review native values and tracker schema/policy before retrying; no source writes or hooks ran.", "plan");
  }
  const { projected, ...projectionSource } = projection;
  if (schemaDigest(projectionSource) !== schemaDigest(view)) throw new LinearOwnershipRefusal("source_changed", "Local state changed while the SDK projection was staged. Read both systems again; no source writes were attempted.");
  const incoming = project(projected!);
  const current = project(local);
  const observation: LinearOwnershipSnapshot = {
    format: "pm-linear/ownership/1", localId: local.id!, linearId, mapping,
    localRevision: schemaDigest(local), providerRevision: schemaDigest(issue),
    fields: LINEAR_OWNERSHIP_FIELDS.map((field) => ({ field, local: current.get(field)!, provider: incoming.get(field)! })),
  };
  const supplied = options.base;
  const compatible = supplied && supplied.format === observation.format && supplied.localId === observation.localId && supplied.linearId === linearId && supplied.mapping === mapping;
  const bases = validateOwnershipBase(compatible ? supplied : undefined);
  const counts = { local: 0, provider: 0, conflicts: 0, unknown: 0 };
  const fields = LINEAR_OWNERSHIP_FIELDS.map((field) => {
    const left = current.get(field)!;
    const right = incoming.get(field)!;
    const base = bases.get(field);
    let decision: LinearOwnershipDecision;
    if (!base || !base.local || base.local !== base.provider) decision = "unknown_base";
    else if (left === right) decision = left === base.local ? "unchanged" : "aligned";
    else if (left === base.local) decision = "provider_edit";
    else if (right === base.provider) decision = "local_edit";
    else decision = "conflict";
    if (decision === "local_edit") counts.local++;
    if (decision === "provider_edit") counts.provider++;
    if (decision === "conflict") counts.conflicts++;
    if (decision === "unknown_base") counts.unknown++;
    return { field, decision };
  });
  const verified = await observe();
  let fresh: ClosureReadView;
  try { fresh = await readClosureItems(source, [options.item]); }
  catch { throw new LinearOwnershipRefusal("local_read_failed", "Restore complete local reads and retry both observations; no saved plan authorizes a write."); }
  if (schemaDigest(issue) !== schemaDigest(verified) || schemaDigest(view) !== schemaDigest(fresh)) throw new LinearOwnershipRefusal("source_changed", "Local or provider state changed during observation. Read both again and review a new preview; saved plans never authorize writes.");
  const report: LinearOwnershipReport = {
    ok: true, mode: "preview", atomicCrossSystem: false,
    guarantee: "Observations only; no atomic cross-system guarantees. Values can change after reading. Native SDK effects only; authorization and extension effects remain unvalidated.",
    base: supplied ? compatible ? "acknowledged" : "foreign" : "missing",
    disjoint: counts.local > 0 && counts.provider > 0 && counts.conflicts === 0 && counts.unknown === 0,
    fields, counts, observation,
    remedy: "Review conflicts and unknown bases explicitly. Re-read both systems before any separate write; promote an observation to a baseline only after acknowledging every field.",
  };
  if (!closureMatches(report.observation, ownershipSnapshotShape) || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > LINEAR_OWNERSHIP_FIELDS.length)) throw new LinearOwnershipRefusal("source_invalid", "Restore valid native field metadata and retry; no invalid receipt is returned at receipt.observation.", "receipt.observation");
  if (Buffer.byteLength(JSON.stringify(report)) > budget) throw new LinearOwnershipRefusal("output_budget", "Raise --max-output-bytes up to 65536; the complete preview is never truncated.");
  return report;
}

/** Explicit local selections and hard acquisition/output budgets; all operations are read-only. */
export interface LinearClosureOptions {
  items: string[];
  maxDepth?: number;
  maxNodes?: number;
  maxRequests?: number;
  maxRelations?: number;
  maxOutputBytes?: number;
}

/** Machine-readable failures that never include provider errors, credentials or local paths. */
export type LinearClosureRefusalCode = "invalid_input" | "selection_required" | "local_read_failed" | "source_invalid" | "source_changed" | "output_budget";

/** Recoverable refusal for invalid selection, incomplete local evidence or malformed provider data. */
export class LinearClosureRefusal extends CommandError {
  /** Stable category for agent branching. */
  readonly code: LinearClosureRefusalCode;
  /** Action needed before retrying the observational acquisition. */
  readonly remedy: string;
  /** Schema-owned path when malformed provider data caused the refusal. */
  readonly field?: string;
  constructor(code: LinearClosureRefusalCode, remedy: string, field?: string) {
    super(`Linear dependency closure refused (${code}). ${remedy}`, EXIT_CODE.USAGE);
    this.name = "LinearClosureRefusal";
    this.field = field;
    this.code = code;
    this.remedy = remedy;
  }
}

/** One observed prerequisite, with null metadata until its issue read succeeds. */
export interface LinearClosureIssue {
  id: string;
  identifier: string | null;
  title: string | null;
  depth: number;
  localId: string | null;
  read: boolean;
}

/** Why the provider frontier remains unresolved; this is never evidence of readiness. */
export interface LinearClosureBoundary {
  id: string;
  reason: "access_denied" | "unavailable" | "depth_cap" | "node_cap" | "request_cap" | "relation_cap";
  remedy: string;
}

/** Compact observation receipt; complete means acquisition finished, not that work is unblocked. */
export interface LinearClosureReport {
  ok: true;
  mode: "preview";
  complete: boolean;
  selected: string[];
  issues: LinearClosureIssue[];
  frontier: string[];
  prerequisites: { issue: string; blocker: string }[];
  boundaries: LinearClosureBoundary[];
  measured: { nodes: number; requests: number; relations: number };
  caps: { depth: number; nodes: number; requests: number; relations: number; outputBytes: number };
}

/** Declarative boundary vocabulary shared by options, provider responses and emitted receipts. */
type ClosureShape = { kind: "opaque" } | { kind: "record"; max: number; row: ClosureShape } | { kind: "string"; max: number; pattern?: RegExp; empty?: boolean } |
  { kind: "number"; min: number; max: number; fractional?: boolean } | { kind: "boolean" } |
  { kind: "literal"; value: string | boolean } | { kind: "array"; max: number; row: ClosureShape } |
  { kind: "object"; fields: Record<string, ClosureShape>; optional?: string[]; additional?: boolean; requiredAny?: string[] } |
  { kind: "nullable"; inner: ClosureShape };

const closureId: ClosureShape = { kind: "string", max: 128, pattern: /^[a-zA-Z0-9_-]+$/ };
const closureText: ClosureShape = { kind: "string", max: 1024 };
const closureNullableId: ClosureShape = { kind: "nullable", inner: closureId };
const closureNullableText: ClosureShape = { kind: "nullable", inner: closureText };
const closureBoolean: ClosureShape = { kind: "boolean" };
const closureCount: ClosureShape = { kind: "number", min: 0, max: 1024 };
const closureOptionsShape: ClosureShape = { kind: "object", fields: {
  items: { kind: "array", max: 16, row: closureId },
  maxDepth: { kind: "number", min: 0, max: 8 },
  maxNodes: { kind: "number", min: 1, max: 128 },
  maxRequests: { kind: "number", min: 1, max: 256 },
  maxRelations: { kind: "number", min: 1, max: 1024 },
  maxOutputBytes: { kind: "number", min: 1024, max: 131072 },
}, optional: ["maxDepth", "maxNodes", "maxRequests", "maxRelations", "maxOutputBytes"] };
const closureIssueShape: ClosureShape = { kind: "object", fields: {
  id: closureId, identifier: closureNullableText, title: closureNullableText,
  depth: { kind: "number", min: 0, max: 8 }, localId: closureNullableId, read: closureBoolean,
} };
const closureProviderShape: ClosureShape = { kind: "nullable", inner: { kind: "object", fields: {
  id: closureId, identifier: closureText, title: closureText, updatedAt: closureText,
  inverseRelations: { kind: "object", fields: {
    nodes: { kind: "array", max: 50, row: { kind: "object", fields: {
      id: closureId, type: closureText,
      issue: { kind: "nullable", inner: { kind: "object", fields: { id: closureId } } },
      relatedIssue: { kind: "object", fields: { id: closureId } },
    } } },
    pageInfo: { kind: "object", fields: { hasNextPage: closureBoolean, endCursor: closureNullableText } },
  } },
} } };
const closureReportShape: ClosureShape = { kind: "object", fields: {
  ok: { kind: "literal", value: true }, mode: { kind: "literal", value: "preview" }, complete: closureBoolean,
  selected: { kind: "array", max: 16, row: closureId },
  issues: { kind: "array", max: 128, row: closureIssueShape },
  frontier: { kind: "array", max: 1024, row: closureId },
  prerequisites: { kind: "array", max: 1024, row: { kind: "object", fields: { issue: closureId, blocker: closureId } } },
  boundaries: { kind: "array", max: 1024, row: { kind: "object", fields: { id: closureId, reason: closureText, remedy: closureText } } },
  measured: { kind: "object", fields: { nodes: closureCount, requests: closureCount, relations: closureCount } },
  caps: { kind: "object", fields: { depth: closureCount, nodes: closureCount, requests: closureCount, relations: closureCount,
    outputBytes: { kind: "number", min: 1024, max: 131072 } } },
} };

/** Validate consumed fields once with the shared schema and retain a safe diagnostic coordinate. */
function closureInvalidField(value: unknown, shape: ClosureShape, path: string): string | undefined {
  switch (shape.kind) {
    case "opaque": return undefined;
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length > shape.max) return path;
      for (const entry of Object.values(value)) { const invalid = closureInvalidField(entry, shape.row, `${path}.entry`); if (invalid) return invalid; }
      return undefined;
    }
    case "string": return typeof value === "string" && (shape.empty || value.length > 0) && value.length <= shape.max && (!shape.pattern || shape.pattern.test(value)) ? undefined : path;
    case "number": return typeof value === "number" && (shape.fractional ? Number.isFinite(value) : Number.isSafeInteger(value)) && value >= shape.min && value <= shape.max ? undefined : path;
    case "boolean": return typeof value === "boolean" ? undefined : path;
    case "literal": return value === shape.value ? undefined : path;
    case "nullable": return value === null ? undefined : closureInvalidField(value, shape.inner, path);
    case "array": {
      if (!Array.isArray(value) || value.length > shape.max) return path;
      for (let index = 0; index < value.length; index++) {
        const child = `${path}[${index}]`;
        if (!Object.hasOwn(value, index)) return child;
        const invalid = closureInvalidField(value[index], shape.row, child);
        if (invalid) return invalid;
      }
      return undefined;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return path;
      const row = value as Record<string, unknown>;
      if (shape.requiredAny && !shape.requiredAny.some((key) => Object.hasOwn(row, key))) return `${path}.${shape.requiredAny[0]}`;
      if (!shape.additional && Object.keys(row).some((key) => !Object.hasOwn(shape.fields, key))) return path;
      for (const [key, field] of Object.entries(shape.fields)) {
        if (shape.optional?.includes(key) && row[key] === undefined) continue;
        if (!Object.hasOwn(row, key)) return `${path}.${key}`;
        const invalid = closureInvalidField(row[key], field, `${path}.${key}`);
        if (invalid) return invalid;
      }
      return undefined;
    }
  }
}

/** Boolean facade used by existing producers and consumers of the same schemas. */
function closureMatches(value: unknown, shape: ClosureShape): boolean {
  return closureInvalidField(value, shape, "value") === undefined;
}

/** Validate all rows and identities before returning any authoritative baseline field. */
function validateOwnershipBase(base: LinearOwnershipSnapshot | undefined): Map<LinearOwnershipField, { local: string; provider: string }> {
  const candidates = new Map<LinearOwnershipField, { local: string; provider: string }>();
  const seen = new Set<LinearOwnershipField>();
  const invalid = new Set<LinearOwnershipField>();
  let unidentifiable = false;
  for (const value of base?.fields ?? []) {
    const row: unknown = value;
    const valid = closureMatches(row, ownershipFieldShape);
    if (typeof row !== "object" || row === null || Array.isArray(row)) { unidentifiable = true; continue; }
    const field = (row as Record<string, unknown>).field;
    if (!LINEAR_OWNERSHIP_FIELDS.some((name) => name === field)) { unidentifiable = true; continue; }
    const name = field as LinearOwnershipField;
    if (seen.has(name) || !valid) invalid.add(name);
    seen.add(name);
    if (valid) candidates.set(name, value);
  }
  if (unidentifiable) return new Map();
  for (const field of invalid) candidates.delete(field);
  return candidates;
}

/** Every transport consumer receives the same validated GraphQL envelope. */
const linearEnvelopeShape: ClosureShape = { kind: "object", fields: {
  data: { kind: "nullable", inner: { kind: "record", max: 10000, row: { kind: "opaque" } } },
  errors: { kind: "array", max: 1000, row: { kind: "object", fields: { message: { kind: "string", max: 65536, empty: true } }, additional: true } },
}, optional: ["data", "errors"], requiredAny: ["data", "errors"], additional: true };

/** Export metadata permits partial optional connections but never malformed containers or scalar types. */
const linearTeamRowShape: ClosureShape = { kind: "object", fields: {
  id: closureText, name: { kind: "nullable", inner: { kind: "string", max: 32768, empty: true } },
  number: { kind: "nullable", inner: { kind: "number", min: 0, max: Number.MAX_SAFE_INTEGER, fractional: true } },
}, optional: ["id", "name", "number"], additional: true };
const linearTeamConnectionShape: ClosureShape = { kind: "nullable", inner: { kind: "object", fields: {
  nodes: { kind: "array", max: 10000, row: linearTeamRowShape },
}, optional: ["nodes"], additional: true } };
const linearTeamDataShape: ClosureShape = { kind: "nullable", inner: { kind: "object", fields: {
  teams: { kind: "object", fields: { nodes: { kind: "array", max: 10000, row: { kind: "object", fields: {
    id: closureText, states: linearTeamConnectionShape, labels: linearTeamConnectionShape, cycles: linearTeamConnectionShape,
  }, optional: ["id", "states", "labels", "cycles"], additional: true } } }, optional: ["nodes"], additional: true },
}, optional: ["teams"], additional: true } };
const preflightSourceFieldShape: ClosureShape = { kind: "string", max: 128,
  pattern: /^(?:response(?:\.(?:data|errors(?:\[[0-9]{1,3}\](?:\.message)?)?))?|viewer(?:\.viewer(?:\.id)?)?)$/ };
const linearViewerDataShape: ClosureShape = { kind: "nullable", inner: { kind: "object", fields: {
  viewer: { kind: "nullable", inner: { kind: "object", fields: { id: closureText }, optional: ["id"], additional: true } },
}, optional: ["viewer"], additional: true } };

const ownershipDigest: ClosureShape = { kind: "string", max: 64, pattern: /^[a-f0-9]{64}$/ };
const ownershipText: ClosureShape = { kind: "string", max: 32768, empty: true };
const ownershipName: ClosureShape = { kind: "object", fields: { name: ownershipText } };
const ownershipNullableName: ClosureShape = { kind: "nullable", inner: ownershipName };
const ownershipFieldShape: ClosureShape = { kind: "object", fields: {
  field: { kind: "string", max: 16, pattern: new RegExp(`^(${LINEAR_OWNERSHIP_FIELDS.join("|")})$`) }, local: ownershipDigest, provider: ownershipDigest,
} };
const ownershipSnapshotShape: ClosureShape = { kind: "object", fields: {
  format: { kind: "literal", value: "pm-linear/ownership/1" }, localId: closureId, linearId: closureId,
  mapping: ownershipDigest, localRevision: ownershipDigest, providerRevision: ownershipDigest,
  fields: { kind: "array", max: LINEAR_OWNERSHIP_FIELDS.length, row: ownershipFieldShape },
} };
const ownershipOptionsShape: ClosureShape = { kind: "object", fields: {
  item: closureId, base: { ...ownershipSnapshotShape, fields: { ...(ownershipSnapshotShape as Extract<ClosureShape, { kind: "object" }>).fields, fields: { kind: "array", max: LINEAR_OWNERSHIP_FIELDS.length, row: { kind: "opaque" } } } } as ClosureShape, statusMap: { kind: "record", max: 128, row: closureText },
  maxOutputBytes: { kind: "number", min: 2048, max: 65536 },
}, optional: ["base", "statusMap", "maxOutputBytes"] };
const linearIssueShape: Extract<ClosureShape, { kind: "object" }> = { kind: "object", fields: {
  id: closureId, identifier: closureText, title: ownershipText, description: { kind: "nullable", inner: ownershipText },
  priority: { kind: "number", min: 0, max: 4 }, estimate: { kind: "nullable", inner: { kind: "number", min: 0, max: 1000000, fractional: true } },
  state: { kind: "object", fields: { name: ownershipText, type: ownershipText } },
  labels: { kind: "object", fields: { nodes: { kind: "array", max: LINEAR_ISSUE_LABEL_CAP, row: ownershipName }, pageInfo: { kind: "object", fields: { hasNextPage: { kind: "literal", value: false } } } } },
  dueDate: { kind: "nullable", inner: ownershipText }, cycle: { kind: "nullable", inner: { kind: "object", fields: { name: { kind: "nullable", inner: ownershipText } }, optional: ["name"] } },
  assignee: { kind: "nullable", inner: { kind: "object", fields: { name: { kind: "nullable", inner: ownershipText }, email: { kind: "nullable", inner: ownershipText } } } },
  project: ownershipNullableName, customer: ownershipNullableName, url: { kind: "nullable", inner: ownershipText }, updatedAt: closureText,
}, optional: ["estimate", "cycle", "assignee", "project", "customer", "url", "updatedAt"] };
const ownershipIssueShape: ClosureShape = { ...linearIssueShape, optional: linearIssueShape.optional!.filter((key) => key !== "updatedAt") };
const importIssueShape: ClosureShape = { ...linearIssueShape, fields: { ...linearIssueShape.fields, labels: { ...(linearIssueShape.fields.labels as Extract<ClosureShape, { kind: "object" }>), optional: ["pageInfo"] } } };
/** Validate optional import connections and every consumed page coordinate before planning. */
const linearIssuesDataShape: ClosureShape = { kind: "nullable", inner: { kind: "object", fields: {
  issues: { kind: "nullable", inner: { kind: "object", fields: {
    nodes: { kind: "array", max: LINEAR_MAX_PAGE_SIZE, row: importIssueShape },
    pageInfo: { kind: "nullable", inner: { kind: "object", fields: {
      hasNextPage: closureBoolean, endCursor: { kind: "nullable", inner: ownershipText },
    }, optional: ["hasNextPage", "endCursor"], additional: true } },
  }, optional: ["nodes", "pageInfo"], additional: true } },
}, optional: ["issues"], additional: true } };
const OWNERSHIP_QUERY = `query LinearOwnership($id: String!) {
  issue(id: $id) { id identifier title description priority estimate updatedAt
    state { name type } labels(first: ${LINEAR_ISSUE_LABEL_CAP}) { nodes { name } pageInfo { hasNextPage } }
    dueDate cycle { name } assignee { name email } project { name } customer { name } url
  }
}`;

const CLOSURE_QUERY = `query LinearPrerequisites($id: String!, $after: String) {
  issue(id: $id) { id identifier title updatedAt
    inverseRelations(first: 50, after: $after, includeArchived: true) {
      nodes { id type issue { id } relatedIssue { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Certified isolated membership plus SDK-resolved selections and configuration identity. */
interface ClosureReadView {
  items: PmItem[];
  selectedIds: Array<string | null>;
  configuration: string;
  settings: Awaited<ReturnType<Awaited<ReturnType<typeof importRuntimeSdk>>["readSettings"]>>;
  /** SDK-applied import projection read from an owned disposable copy only. */
  projected?: PmItem;
}

/**
 * Isolate bytes before any settings/schema read can repair or backfill files.
 * The bounded bootstrap copy applies no item-folder filter. SDK complete reads
 * discover membership there; SDK locateItem supplies the exact item files for
 * the final read view. Only owned copies ever reach repairing SDK entry points.
 * The source is an absolute, canonical tracker path resolved by the boundary.
 */
async function readClosureItems(source: string, selections: string[], projection?: PreparedLinearImport): Promise<ClosureReadView> {
  const scratch = await mkdtemp(join(tmpdir(), "pm-linear-read-"));
  const bootstrap = join(scratch, "bootstrap");
  const reader = join(scratch, "reader");
  let files = 0;
  let bytes = 0;
  /** Restore write access only inside owned copies, including after an interrupted copy. */
  async function writableMirror(): Promise<boolean> {
    let links = false;
    await chmod(scratch, 0o700);
    for (const entry of await readdir(scratch, { recursive: true, withFileTypes: true })) {
      links ||= entry.isSymbolicLink();
      if (entry.isDirectory()) await chmod(join(entry.parentPath, entry.name), 0o700);
    }
    return links;
  }
  try {
    await cp(source, bootstrap, { recursive: true, filter: async (path) => {
      const info = await lstat(path);
      // Installed packages carry the host SDK link. It is runtime code, never
      // tracker membership; do not follow or copy it into observational reads.
      if (info.isSymbolicLink() && /^extensions\/[^/]+\/node_modules\/@unbrained\/pm-cli$/.test(relative(source, path).replaceAll("\\", "/"))) return false;
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error("Unsupported tracker entry");
      files++;
      bytes += info.isFile() ? info.size : 0;
      if (files > 20000 || bytes > 67108864) throw new Error("Tracker isolation budget exceeded");
      return true;
    } });
    if (await writableMirror()) throw new Error("Copied tracker contains a symbolic link");
    const sdk = await importRuntimeSdk();
    const settings = await sdk.readSettings(bootstrap);
    const settingsPath = sdk.getSettingsPath(bootstrap);
    // Missing configuration is recoverable only in the owned bootstrap copy.
    if (!await sdk.pathExists(settingsPath)) await sdk.writeFileAtomic(settingsPath, JSON.stringify(settings));
    const registry = sdk.resolveItemTypeRegistry(settings);
    const enumerated = await readPmItems(bootstrap);
    await mkdir(reader);
    await cp(settingsPath, sdk.getSettingsPath(reader));
    await cp(join(bootstrap, "schema"), join(reader, "schema"), { recursive: true });
    for (const item of enumerated) {
      const located = await sdk.locateItem(bootstrap, item.id!, settings.id_prefix, settings.item_format, registry.type_to_folder);
      if (!located) throw new Error("SDK membership changed during isolation");
      const file = relative(bootstrap, located.itemPath);
      if (file.startsWith("..") || isAbsolute(file)) throw new Error("SDK item lies outside the isolated tracker");
      const target = join(reader, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(located.itemPath, target);
    }
    if (await writableMirror()) throw new Error("SDK read view contains a symbolic link");
    const items = await readPmItems(reader);
    if (schemaDigest(items) !== schemaDigest(enumerated)) throw new Error("SDK read-view membership diverged");
    const selectedIds: Array<string | null> = [];
    for (const id of selections) {
      const located = await sdk.locateItem(reader, id, settings.id_prefix, settings.item_format, registry.type_to_folder);
      selectedIds.push(located?.id ?? null);
    }
    const sourceView = { items: structuredClone(items), selectedIds, configuration: schemaDigest(settings), settings: structuredClone(settings) };
    let projected: PmItem | undefined;
    if (projection) {
      const transactionSdk = await loadAtomicSdk();
      const commit = assertSdkFunction(transactionSdk.commitItemMutations, "commitItemMutations");
      const withoutHooks = assertSdkFunction(transactionSdk.runWithActiveExtensions, "runWithActiveExtensions");
      const planned = buildAtomicImportMutations("ownership", projection, settings.id_prefix, sdk.normalizeItemId);
      // Use the actual coordinator, including its inspection/skip semantics.
      // Permissions are bypassed only on owned copies, never on source state.
      const mutations: BulkItemMutation[] = planned.mutations.map((mutation) => ({ ...mutation, options: { ...mutation.options, force: true } }));
      const revision = schemaDigest({ target: projection.match, mutations });
      await withoutHooks({ path: reader, noExtensions: true }, () => commit({ pmRoot: reader, transactionId: `projection-${revision}`, author: "pm-linear", mutations }));
      projected = (await readPmItems(reader)).find((item) => item.id === projection.match?.id);
      if (!projected) throw new Error("SDK projection target disappeared");
    }
    return { ...sourceView, ...(projected ? { projected } : {}) };
  } finally {
    await writableMirror();
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Acquire only the inverse blocks frontier of explicitly selected linked items.
 * Certified SDK reads supply identity and imported membership. Each HTTP attempt
 * is charged once, with no retry, persistence, import or provider mutation. Local
 * status names are never interpreted: all prerequisites are context to read.
 */
export async function fetchLinearDependencyClosure(options: LinearClosureOptions, pmRoot: string): Promise<LinearClosureReport> {
  const callerCwd = process.cwd();
  if (!closureMatches(options, closureOptionsShape)) {
    throw new LinearClosureRefusal("invalid_input", "Pass 1..16 item IDs and integer budgets in the documented ranges; remove unknown options.");
  }
  const caps = { depth: options.maxDepth ?? 3, nodes: options.maxNodes ?? 32, requests: options.maxRequests ?? 64,
    relations: options.maxRelations ?? 128, outputBytes: options.maxOutputBytes ?? 16384 };
  if (!options.items.length || options.items.length > caps.nodes || new Set(options.items).size !== options.items.length) {
    throw new LinearClosureRefusal("selection_required", "Select 1..16 distinct linked local items and allow at least one node for each selection.");
  }
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new LinearClosureRefusal("selection_required", "Set LINEAR_API_KEY with read access to the explicitly selected linked issues, then retry.");
  let sdk: Awaited<ReturnType<typeof importRuntimeSdk>>;
  try { sdk = await importRuntimeSdk(); }
  catch { throw new LinearClosureRefusal("local_read_failed", "Install a compatible pm SDK and retry with a readable initialized tracker."); }
  const local = new Map<string, string>();
  let source: string;
  let view: ClosureReadView;
  let corpus: PmItem[];
  try {
    if (typeof pmRoot !== "string" || !pmRoot.trim()) throw new Error("Explicit tracker path required");
    source = await realpath(sdk.resolvePmRoot(callerCwd, pmRoot));
    view = await readClosureItems(source, options.items);
    corpus = view.items;
    for (const item of corpus) {
      const id = parseProvenance(item.description)?.linear_id;
      if (!id) continue;
      if (!closureMatches(id, closureId) || local.has(id)) throw new Error("Ambiguous or invalid Linear provenance");
      local.set(id, item.id!);
    }
  } catch { throw new LinearClosureRefusal("local_read_failed", "Repair unreadable items or duplicate Linear provenance, then retry with a certified complete SDK read."); }
  const selected: string[] = [];
  try {
    for (const [index] of options.items.entries()) {
      const item = corpus.find((row) => row.id === view.selectedIds[index]);
      if (!item) throw new Error("Missing selection");
      const linked = parseProvenance(item.description)?.linear_id;
      if (!linked || local.get(linked) !== item.id) throw new Error("Selection is unlinked or changed");
      selected.push(linked);
    }
    if (new Set(selected).size !== selected.length) throw new Error("Aliased selection");
  } catch { throw new LinearClosureRefusal("selection_required", "Select existing pm item IDs with unique Linear provenance; import or repair their links first."); }
  const issues = new Map<string, LinearClosureIssue>();
  const prerequisites = new Map<string, { issue: string; blocker: string }>();
  const boundaries = new Map<string, LinearClosureBoundary>();
  const queue: string[] = [];
  let requests = 0;
  let relations = 0;
  /** Retain one explicit unresolved boundary per source and reason, with bounded recovery guidance. */
  function boundary(id: string, reason: LinearClosureBoundary["reason"]): void {
    const remedy = reason === "access_denied" ? "Restore read access to this issue and its prerequisite relations, then retry." :
      reason === "unavailable" ? "Restore Linear availability and retry the read-only preview." :
      "Increase the corresponding declared cap within its documented limit, or narrow the selection, then retry.";
    boundaries.set(`${id}:${reason}`, { id, reason, remedy });
  }
  /** Charge unique identities before queuing; never pretend an omitted blocker was acquired. */
  function enqueue(id: string, depth: number): void {
    if (issues.has(id)) return;
    if (depth > caps.depth) { boundary(id, "depth_cap"); return; }
    if (issues.size >= caps.nodes) { boundary(id, "node_cap"); return; }
    issues.set(id, { id, identifier: null, title: null, depth, localId: local.get(id) ?? null, read: false });
    queue.push(id);
  }
  for (const id of selected) enqueue(id, 0);
  for (const id of queue) {
    const current = issues.get(id)!;
    const cursors = new Set<string>();
    const relationIds = new Set<string>();
    let after: string | null = null;
    let revision: string | undefined;
    do {
      if (requests >= caps.requests) { boundary(id, "request_cap"); break; }
      requests++;
      let response: LinearResponse<{ issue: unknown }>;
      try { response = await linearRequestOnce<{ issue: unknown }>(apiKey, CLOSURE_QUERY, { id, after }, 262144); }
      catch (error: unknown) {
        if (error instanceof LinearSourceRefusal) throw new LinearClosureRefusal("source_invalid", error.remedy, error.field);
        boundary(id, error instanceof AuthHttpError ? "access_denied" : "unavailable"); break;
      }
      if (typeof response !== "object" || response === null || Array.isArray(response)) {
        throw new LinearClosureRefusal("source_invalid", "Retry with a valid Linear GraphQL response envelope containing the selected issue.");
      }
      if (response.errors?.length || response.data?.issue === null) { boundary(id, "access_denied"); break; }
      const raw = response.data?.issue;
      const invalid = closureInvalidField(raw, closureProviderShape, "issue");
      if (invalid) {
        throw new LinearClosureRefusal("source_invalid", `Retry with complete, bounded issue and relation pages matching the documented GraphQL schema at ${invalid}.`, invalid);
      }
      const issue = raw as { id: string; identifier: string; title: string; updatedAt: string;
        inverseRelations: { nodes: { id: string; type: string; issue: { id: string } | null; relatedIssue: { id: string } }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      if (issue.id !== id) throw new LinearClosureRefusal("source_invalid", "Retry with the requested issue identity; provider aliases cannot substitute another issue.");
      const fingerprint = schemaDigest([issue.id, issue.identifier, issue.title, issue.updatedAt]);
      if (revision !== undefined && revision !== fingerprint) throw new LinearClosureRefusal("source_changed", "The selected issue changed while paging. Retry a fresh read-only preview.");
      revision = fingerprint;
      current.identifier = issue.identifier;
      current.title = issue.title;
      const page = issue.inverseRelations;
      let stopped = false;
      for (const relation of page.nodes) {
        if (relations >= caps.relations) { boundary(id, "relation_cap"); stopped = true; break; }
        relations++;
        if (relationIds.has(relation.id) || relation.relatedIssue.id !== id) {
          throw new LinearClosureRefusal("source_invalid", "Retry after duplicate or incorrectly directed relation rows are repaired; no partial frontier is certified.");
        }
        relationIds.add(relation.id);
        if (relation.type !== "blocks") continue;
        if (!relation.issue) { boundary(id, "access_denied"); continue; }
        const blocker = relation.issue.id;
        prerequisites.set(`${id}:${blocker}`, { issue: id, blocker });
        enqueue(blocker, current.depth + 1);
      }
      if (stopped) break;
      current.read = true;
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
      if (!after || cursors.has(after) || !page.nodes.length) {
        throw new LinearClosureRefusal("source_invalid", "Retry with advancing, nonempty prerequisite pages and complete pagination metadata.");
      }
      cursors.add(after);
      current.read = false;
    } while (true);
  }
  // The operation has no apply/recovery state. Re-read membership so concurrent
  // local edits cannot silently turn a missing prerequisite into imported context.
  try {
    const latest = await readClosureItems(source, options.items);
    if (schemaDigest(latest) !== schemaDigest(view)) throw new Error("Changed corpus");
  } catch { throw new LinearClosureRefusal("source_changed", "The local tracker changed or became unreadable during acquisition. Retry a fresh preview."); }
  const report: LinearClosureReport = { ok: true, mode: "preview", complete: boundaries.size === 0,
    selected, issues: [...issues.values()], frontier: [...new Set([...prerequisites.values()].map((edge) => edge.blocker))].filter((id) => !local.has(id)),
    prerequisites: [...prerequisites.values()], boundaries: [...boundaries.values()],
    measured: { nodes: issues.size, requests, relations }, caps };
  if (!closureMatches(report, closureReportShape) || requests > caps.requests || issues.size > caps.nodes || relations > caps.relations) {
    throw new LinearClosureRefusal("source_invalid", "The complete receipt failed its bounded output contract. Narrow the selection and retry.");
  }
  if (Buffer.byteLength(JSON.stringify(report)) + 256 > caps.outputBytes) {
    throw new LinearClosureRefusal("output_budget", "Raise --max-output-bytes up to 131072 or narrow the selection; the complete frontier is never silently truncated.");
  }
  return report;
}

/** Shared sync controls, including a previously negotiated schema version. */
export interface SyncOptions {
  schemaVersion?: string;
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
  /** Inject metadata negotiation together with an offline issue provider. */
  negotiateSchema?: typeof negotiateLinearSchema;
  /** Inject the Linear fetch (offline tests). */
  fetchIssues?: (
    apiKey: string,
    team: string,
    limit: number,
    filters: FetchFilters,
  ) => Promise<LinearIssue[]>;
  /** Inject the local pm item read. */
  readItems?: (pmRoot: string) => PmItem[] | Promise<PmItem[]>;
  /** Inject the atomic commit (offline/dry-run tests). */
  commitAtomic?: typeof importLinearAtomic;
}

/** Counts and schema evidence returned by either supported writer path. */
export interface SyncResult {
  /** SDK-only desired field plans from the exact atomic dry-run preparation used by writes. CLI receipts retain compact counts. */
  prepared?: PreparedLinearImport[];
  schema?: LinearSchemaReport;
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

/** Quarantine every non-unique provider identity before any import target is selected. */
function ambiguousLinearIds(items: PmItem[]): Set<string> {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const item of items) {
    const id = parseProvenance(item.description)?.linear_id;
    if (!id) continue;
    if (seen.has(id)) ambiguous.add(id);
    seen.add(id);
  }
  return ambiguous;
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
    if (prov?.linear_id) Object.defineProperty(index, prov.linear_id, { value: item, enumerable: true, writable: true, configurable: true });
  }
  for (const id of ambiguousLinearIds(items)) delete index[id];
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
  assertLiteralImportValues(plan);
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

async function buildImportDryRunPlan(
  options: SyncOptions,
  pm_root: string
): Promise<ImportDryRunPlan> {
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
  const existingLinkedItems = (await readPmItems(pm_root)).filter((item) => parseProvenance(item.description) !== undefined).length;
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
// uses the same mapped fields; --atomic --dry-run shares the atomic preparation/matching path
// and reports create/update/skip counts WITHOUT touching the SDK commit.

const ATOMIC_IMPORT_PREFIX = "linear-import-";

type CommitItemMutations = (
  options: CommitItemMutationsOptions,
) => Promise<CommitItemMutationsResult>;
type NormalizeItemId = (input: string, prefix: string) => string;
type ReadSettings = (pmRoot: string) => Promise<{ id_prefix?: string }>;

/**
 * Optional inputs to an atomic Linear import: author attribution and test seams.
 *
 * Every field is optional; the live path resolves the SDK helpers itself, while
 * the seams let a test inject `commitItemMutations`, `normalizeItemId`, and
 * `readSettings` so the crash-recovery and compensation branches run offline
 * without touching the real workspace transaction journal.
 */
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

function assertSdkFunction<F extends (...args: never[]) => unknown>(
  fn: F | undefined,
  exportName: string,
): F {
  if (typeof fn !== "function") {
    throw new CommandError(
      `--atomic requires @unbrained/pm-cli>=2026.7.20 with the commitItemMutations SDK primitive, but the installed SDK does not export ${exportName} as a function. Upgrade @unbrained/pm-cli to >=2026.7.20.`,
      EXIT_CODE.USAGE,
    );
  }
  return fn;
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

/** Use the SDK's JSON-array tag input so commas, unset words and stdin tokens stay literal labels. */
function linearTagInput(tags: readonly string[]): string {
  return JSON.stringify([...tags].sort());
}

/** Encode literal mapped fields for the SDK option contract shared by both import writers. */
function linearImportOptions(entry: ItemPlan) {
  assertLiteralImportValues(entry);
  return {
    title: entry.title, priority: entry.priority, description: entry.description, body: entry.body,
    // JSON arrays escape label control words, commas, quotes and stdin tokens.
    tags: linearTagInput(entry.tags),
    ...(entry.deadline ? { deadline: entry.deadline } : {}),
    ...(entry.assignee ? { assignee: entry.assignee } : {}),
  };
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
  const sharedOptions = linearImportOptions(entry);

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
  const matchId = entry.match?.id;
  if (!matchId || matchId === managedItemId) {
    const mutations: BulkItemMutation[] = [
      {
        op: "create",
        id: managedItemId,
        options: {
          ...sharedOptions,
          parent: "none",
          unset: ["goal", "objective", "sprint", "release"],
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

  const itemId = matchId;
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
  for (const entry of entries) assertLiteralImportValues(entry);
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
    if (settings.id_prefix) idPrefix = settings.id_prefix;
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
    const recovered = result.recovered;
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
    throw new LinearSchemaRefusal("access_denied",
      "LINEAR_API_KEY environment variable is not set. Get your API key with Read access at https://linear.app/settings/api and retry.");
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

  // Certify the entire matching corpus before provider access or item writes.
  const existingItems = await (dependencies.readItems ?? readPmItems)(pm_root);
  const existingByLinearId = indexItemsByLinearId(existingItems);
  const ambiguous = ambiguousLinearIds(existingItems);
  const negotiate = dependencies.negotiateSchema ?? (dependencies.fetchIssues && options.schemaVersion === undefined ? undefined : negotiateLinearSchema);
  const schema = await negotiate?.(options, pm_root);
  const issues = await (dependencies.fetchIssues ?? fetchAllLinearIssues)(apiKey ?? "", options.team, options.limit, filters);

  if (schema) {
    // Revalidate after the provider read and before either writer path.
    await negotiate!({ ...options, schemaVersion: schema.schemaVersion }, pm_root);
    console.error(JSON.stringify({ linearSchema: schema }));
  }

  if (issues.length === 0) {
    console.error(`No issues found for team "${options.team}"${scope}. Check the team slug, filters, and your API key permissions.`);
    return { synced: 0, created: 0, updated: 0, skipped: 0, team: options.team, ...(schema ? { schema } : {}), issues: [] };
  }

  const statusMap = options.statusMap ?? {};

  // `skipped` is shared by both the atomic and legacy paths; `created`/`updated`
  // are declared with the legacy loop below (the atomic path returns before it
  // and reports its own counts, so hoisting them here would be a dead store).
  let skipped = 0;

  // Resolve and validate the entire selected batch before the first write.
  const prepared: PreparedLinearImport[] = [];
  for (const issue of issues) {
    if (ambiguous.has(issue.id)) { skipped++; console.error("Skipped ambiguous local Linear provenance; repair duplicate links before retrying."); continue; }
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
      match: ownMappingValue(existingByLinearId, issue.id),
    });
  }

  if (options.atomic) {
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
        team: options.team, ...(schema ? { schema } : {}),
        issues: [],
        atomic: true,
        dryRun: true,
        prepared,
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
        team: options.team, ...(schema ? { schema } : {}),
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
      team: options.team, ...(schema ? { schema } : {}),
      issues: [],
      atomic: true,
      transactionId: atomicResult.transactionId,
      recovered: atomicResult.recovered,
      ...(atomicResult.recoveredItems !== undefined
        ? { recoveredItems: atomicResult.recoveredItems }
        : {}),
    };
  }

  let created = 0;
  let updated = 0;
  const sdk = await importRuntimeSdk();
  const pm = new sdk.PmClient({ pmRoot: pm_root, noExtensions: true, author: process.env.PM_AUTHOR ?? "pm-linear" });
  for (const entry of prepared) {
    const values = linearImportOptions(entry);
    try {
      if (entry.match?.id) {
        await pm.update(entry.match.id, { ...values, status: entry.status });
        updated++;
      } else {
        await pm.create({ ...values, status: entry.status, parent: "none", unset: ["goal", "objective", "sprint", "release"] });
        created++;
      }
    } catch (error: unknown) {
      console.error(`Failed to ${entry.match?.id ? "update" : "create"} item for ${entry.identifier}: ${error instanceof Error ? error.message : String(error)}`);
      skipped++;
    }
  }

  return {
    synced: created + updated,
    created,
    updated,
    skipped,
    team: options.team, ...(schema ? { schema } : {}),
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

/**
 * The single team node TEAM_QUERY selects, restricted to the fields
 * resolveTeamContext reads. Every field is optional: Linear may return a
 * partial node alongside GraphQL `errors`, and the resolver treats each
 * nested value as suspect until it has been checked (hence the `?.` guards).
 */
interface LinearTeamNode {
  id?: string;
  states?: { nodes: Array<{ id?: string; name?: string }> };
  labels?: { nodes: Array<{ id?: string; name?: string }> };
  cycles?: { nodes: Array<{ id?: string; name?: string | null; number?: number | null }> };
}

/** The `data` payload of TEAM_QUERY: the team-key lookup connection. */
interface LinearTeamData {
  teams?: { nodes: LinearTeamNode[] };
}

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

/**
 * Fetch the team id and its state/label/cycle id maps for push operations.
 *
 * Linear has no fixed global state, label, or cycle ids — they are per-team —
 * so the exporter resolves them once up front and indexes each by lower-cased
 * name. An unknown name simply resolves to nothing and is skipped at push time,
 * so a tag or cycle the team does not model never fails the batch.
 *
 * @param apiKey - The Linear API key.
 * @param teamKey - The team slug (upper-cased to match Linear's key convention).
 * @returns The team id plus the name-to-id lookup maps.
 */
async function resolveTeamContext(apiKey: string, teamKey: string): Promise<TeamContext> {
  const resp = await linearRequest<LinearTeamData>(apiKey, TEAM_QUERY, { key: teamKey.toUpperCase() });
  if (resp.errors?.length) {
    throw new CommandError(
      `Linear API error resolving team ${teamKey}: ${resp.errors.map((e) => e.message).join("; ")}`
    );
  }
  const invalid = closureInvalidField(resp.data, linearTeamDataShape, "team");
  if (invalid) throw new LinearSourceRefusal(invalid);
  const node = resp.data?.teams?.nodes?.[0];
  if (!node?.id) {
    throw new CommandError(`Linear team "${teamKey}" not found.`, EXIT_CODE.NOT_FOUND);
  }
  const statesByName: Record<string, string> = {};
  for (const s of node.states?.nodes ?? []) {
    if (s?.name && s?.id) Object.defineProperty(statesByName, String(s.name).trim().toLowerCase(), { value: s.id, enumerable: true, writable: true, configurable: true });
  }
  const labelsByName: Record<string, string> = {};
  for (const l of node.labels?.nodes ?? []) {
    if (l?.name && l?.id) Object.defineProperty(labelsByName, String(l.name).trim().toLowerCase(), { value: l.id, enumerable: true, writable: true, configurable: true });
  }
  const cyclesByName: Record<string, string> = {};
  for (const c of node.cycles?.nodes ?? []) {
    if (!c?.id) continue;
    if (c.name) Object.defineProperty(cyclesByName, String(c.name).trim().toLowerCase(), { value: c.id, enumerable: true, writable: true, configurable: true });
    // Numbered cycles often have no name; index by number too so a
    // `cycle:42` tag still resolves.
    if (c.number != null) Object.defineProperty(cyclesByName, String(c.number).trim().toLowerCase(), { value: c.id, enumerable: true, writable: true, configurable: true });
  }
  return { teamId: node.id, statesByName, labelsByName, cyclesByName };
}

/**
 * Resolve pm tag names to their existing Linear label ids for a team.
 *
 * Names not present in the team's label map are silently dropped rather than
 * crashing the push, so a tag the workspace does not model is simply ignored.
 * Duplicates are de-duplicated so a repeated label yields one id.
 *
 * @param labels - The pm tag names to resolve.
 * @param labelsByName - A lower-cased-name-to-id map from `resolveTeamContext`.
 * @returns The resolved, de-duplicated label ids.
 */
export function resolveLabelIds(
  labels: string[] | undefined,
  labelsByName: Record<string, string>
): string[] {
  if (!labels?.length) return [];
  const ids: string[] = [];
  for (const name of labels) {
    const id = ownMappingValue(labelsByName, name.trim().toLowerCase());
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Resolve a Linear cycle name or number to its concrete id for a team.
 *
 * Returns undefined when the value matches no cycle — offline, unknown, or a
 * workspace that does not model cycles — so the push skips the field gracefully
 * rather than failing the whole batch.
 *
 * @param cycleName - The cycle name or number to resolve.
 * @param cyclesByName - A lower-cased-name/number-to-id map from `resolveTeamContext`.
 * @returns The cycle id, or undefined when no cycle matches.
 */
export function resolveCycleId(
  cycleName: string | undefined,
  cyclesByName: Record<string, string>
): string | undefined {
  if (!cycleName) return undefined;
  return ownMappingValue(cyclesByName, cycleName.trim().toLowerCase());
}

// Apply estimate + (resolved) cycleId onto a REAL push input (issueCreate or
// issueUpdate). estimate is a finite number copied straight through. cycle is
// resolved by name to a concrete id via the team context; an unresolvable cycle
// is skipped (NOT crashed) and warned about once per process so a batch push of
// many items isn't spammed. Returns the (possibly mutated) input for chaining.
let warnedUnresolvedCycle = false;
/**
 * Reset the once-per-process unresolved-cycle suppression flag.
 *
 * Restores the initial state so a subsequent push warns again about the first
 * cycle that does not resolve; intended for tests that exercise the warning
 * branch repeatedly within one process.
 */
export function resetCycleWarning(): void {
  warnedUnresolvedCycle = false;
}
/**
 * Apply estimate and cycle onto a real Linear push input in place.
 *
 * A finite estimate is copied straight through; the cycle name is resolved to a
 * concrete id via the team map and written when it resolves. An unresolvable
 * cycle is skipped, not crashed, and warned about once per process (see
 * `resetCycleWarning`) so a large batch push is not flooded with repeats.
 *
 * @param input - The mutation input object mutated in place.
 * @param payload - The export payload carrying estimate and cycleName.
 * @param cyclesByName - A name-to-id map from `resolveTeamContext`.
 * @param warn - Sink for the unresolved-cycle warning (defaults to stderr).
 */
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
/**
 * The offline Linear mutation a single pm item would produce on export.
 *
 * Carries the mutation document, its variables, and the resolved target state
 * name. The concrete stateId and label/cycle ids are only knowable with
 * credentials at push time, so the plan carries names (and self-documenting
 * placeholder ids) to stay readable and network-free.
 */
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
const PREFLIGHT_SOURCE_FIELD_OPTION = "__linear_preflight_source_field";

/**
 * Whether an invocation reaches Linear and so requires a credential preflight.
 *
 * The question this answers is "does this invocation touch the Linear API",
 * not "does it write" — because that is precisely what the preflight guards:
 * {@link preflightLinear} demands `LINEAR_API_KEY` and then probes reachability.
 * Asking the narrower mutation question got both edges wrong, in opposite
 * directions:
 *
 * - `export --push --dry-run` writes nothing and is documented as making no
 *   network call, yet a mutation-shaped test saw `--push` and demanded an API
 *   key, so the offline preview failed on any host without one.
 * - `sync`/`import` with `--atomic --dry-run` also writes nothing, but it is
 *   *not* offline: it fetches issues to build the atomic plan. A mutation-shaped
 *   test saw `--dry-run` and skipped the preflight, so a missing or invalid key
 *   surfaced as a raw fetch failure deep in the sync core instead of the clean
 *   USAGE error the preflight exists to produce.
 *
 * So: `--dry-run` alone is offline for `sync`, `import`, and `export`; combined
 * with `--atomic` it still fetches. Every other command is read-only and skips
 * the key check, so a `list` or `validate` never demands a key it does not need.
 *
 * @param command - The full command string (e.g. `linear sync`).
 * @param options - The raw flag bag, inspected for `--dry-run`, `--atomic`, and `--push`.
 * @returns True when the invocation needs a valid, reachable Linear API key.
 */
export function commandNeedsLinearAccess(command: string, options: Record<string, unknown>): boolean {
  const cmd = command.trim().toLowerCase();
  const dryRun = readBooleanOption(options, "dry-run");
  // `linear-sync import` is the deprecated importer alias. It reaches the same
  // write path as `linear import`, so it has to be classified here too --
  // scoping the preflight override to a command list made this omission
  // load-bearing, where the previously global registration had covered it by
  // accident.
  if (cmd === "linear sync" || cmd === "linear import" || cmd === "linear-sync import") {
    // `--atomic --dry-run` is a preview, but it builds that preview from issues
    // it fetches, so it needs the key just as much as a real run.
    return !dryRun || readBooleanOption(options, "atomic");
  }
  if (cmd === "linear export") {
    return readBooleanOption(options, "push") && !dryRun;
  }
  return false;
}

/**
 * Validate the Linear credential, and optionally reachability, before a write.
 *
 * Returns a human-readable error string when the API key is missing or the
 * reachability probe fails, or null when everything checks out. The network
 * probe is gated behind a flag so offline and CI runs stay deterministic.
 *
 * @param checkReachability - Whether to also probe the Linear API over the network.
 * @returns An error message, or null when the credential is acceptable.
 */
async function preflightLinear(
  checkReachability: boolean,
  sourceFailure?: (error: LinearSourceRefusal) => void,
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
    const resp = await linearRequest<LinearViewerData>(apiKey, "query { viewer { id } }", {});
    if (resp.errors?.length) {
      return `Linear API rejected the credentials: ${resp.errors.map((e) => e.message).join("; ")}`;
    }
    const invalid = closureInvalidField(resp.data, linearViewerDataShape, "viewer");
    if (invalid) throw new LinearSourceRefusal(invalid);
    if (!resp.data?.viewer?.id) {
      return "Linear API reachable but returned no viewer; check the API key scope.";
    }
    return null;
  } catch (err) {
    if (err instanceof LinearSourceRefusal) sourceFailure?.(err);
    return `Linear API unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Reduce a credential to a non-reversible fingerprint for safe diagnostics.
 *
 * The point of this value is to answer one operator question — *is the key
 * configured here the key I think it is?* — and a fingerprint answers it
 * strictly better than the previous `lin_…(42 chars)` form did. That form
 * carried the first four characters and the exact length: the prefix is a
 * constant for Linear keys, so it distinguished nothing, while the length is
 * real information about a secret and it was written to a log. Comparing two
 * fingerprints answers the question exactly, and derives from the key in a way
 * that cannot be run backwards.
 *
 * An absent or empty input collapses to an empty string, so callers can still
 * distinguish "no key" from "some key" without a special case.
 *
 * @param key - The raw API key to fingerprint.
 * @returns A 12-hex-character scrypt digest, e.g. `scrypt:1f4b8c2d9e07`, or `""`.
 */
export function maskApiKey(key: string | undefined): string {
  if (!key) return "";
  // A deliberately slow KDF rather than a bare SHA-256. A single-round digest of
  // a credential is cheap to brute-force if the credential is guessable, which
  // is why CodeQL flags it (js/insufficient-password-hash) even when the digest
  // is only ever used as an identifier. scrypt makes that search infeasible.
  // The salt is a fixed, non-secret domain label on purpose: the whole value of
  // this fingerprint is that the SAME key produces the SAME string across runs
  // and machines, which a random salt would destroy. Cost is a few milliseconds,
  // once, in a diagnostic command a human runs by hand.
  return `scrypt:${crypto.scryptSync(key, KEY_FINGERPRINT_SALT, 6).toString("hex")}`;
}

/**
 * Fixed, non-secret domain label for the API-key fingerprint.
 *
 * Deliberately constant. A random salt would make each run produce a different
 * fingerprint, which would defeat the one question the value exists to answer:
 * is the key configured here the same key as before, or the same one my
 * colleague has? It is a domain separator, not a secret.
 */
const KEY_FINGERPRINT_SALT = "pm-linear/api-key-fingerprint/v1";

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

/**
 * Build an offline readiness report from the current environment.
 *
 * Captures whether the API key and default team are configured (without leaking
 * the key — see `maskApiKey`) so `linear validate` can report readiness. The
 * network fields are left unchecked here; a live probe is opt-in elsewhere.
 *
 * @returns The structured validation report.
 */
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

/**
 * Throw a clean USAGE error if a preflight injected its failure sentinel.
 *
 * The preflight override cannot abort by throwing (a throw cancels the override,
 * not the command), so it stashes its error on a private option key; the command
 * handler reads and clears that sentinel here to turn the failure into a
 * `CommandError` at the point a write is about to happen.
 *
 * @param options - The command option bag that may carry the sentinel.
 */
function assertPreflightOk(options: Record<string, unknown>): void {
  const err = options[PREFLIGHT_ERROR_OPTION];
  if (typeof err === "string" && err) {
    const field = options[PREFLIGHT_SOURCE_FIELD_OPTION];
    if (closureMatches(field, preflightSourceFieldShape)) throw new LinearSourceRefusal(field as string);
    throw new CommandError(err, EXIT_CODE.USAGE);
  }
}

// True when the caller passed the GLOBAL --json flag. pm exposes it on
// ctx.global.json (NOT ctx.options); in JSON mode handlers return the object
// and must NOT write their own stdout (the runtime serializes the return
// value). Both command and importer/exporter contexts carry `global`, hence
// the union; the `?.` chain stays because it costs nothing and keeps the
// helper safe against a host that hands through a partial context.
function isJsonMode(ctx: CommandHandlerContext | ImportExportContext): boolean {
  return Boolean(ctx?.global?.json);
}

/**
 * Render an offline import dry-run, making no Linear network call.
 *
 * Builds the literal GraphQL request the import would send and either returns it
 * as the JSON payload or prints a human preview to stderr. Shared by the
 * `linear sync` command and the `linear` importer so both dry-run paths are byte-
 * identical and never touch the network.
 *
 * @param ctx - The command or import context (carries `pm_root` and JSON mode).
 * @param options - The resolved sync options.
 * @param teamSource - Where the team came from, for an explanatory log line.
 * @returns The JSON-mode payload object.
 */
async function renderImportDryRun(
  ctx: CommandHandlerContext | ImportExportContext,
  options: SyncOptions,
  teamSource?: TeamSource
): Promise<Record<string, unknown>> {
  const plan = await buildImportDryRunPlan(options, ctx.pm_root);
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
/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * Declared here rather than imported so this package keeps a type-only
 * dependency on `@unbrained/pm-cli` and adds no runtime module edge. The
 * generic constraint is the SDK's own, so the extension object is contract-
 * checked against {@link ExtensionModule} exactly as the imported helper would.
 */
const defineExtension = <TModule extends ExtensionModule>(module: TModule): TModule => module;

export default defineExtension({
  name: "pm-linear",
  version: "2026.10.29",

  activate(api: ExtensionApi) {
    registerLinearCommand(api, {
      name: "linear ownership",
      description: "Preview field ownership and conflicts against an acknowledged Linear snapshot",
      intent: "Read one linked item without mutating either system; unknown bases require review",
      examples: ["pm linear ownership --item pm-example --json", "pm linear ownership --item pm-example --base acknowledged.json --json"],
      flags: [
        { long: "--item", value_name: "id", description: "One existing item with unique Linear provenance." },
        { long: "--base", value_name: "file", description: "Explicitly acknowledged observation JSON, at most 16 KiB; absent means unknown base." },
        { long: "--status-map", value_name: "map", description: "Same Linear state-to-pm mapping used for import." },
        { long: "--max-output-bytes", value_name: "bytes", description: "Complete receipt budget, 2048..65536 (default 8192)." },
      ],
      async run(ctx) {
        try {
          const options: LinearOwnershipOptions = { item: readStringOption(ctx.options, "item") ?? "" };
          const file = readStringOption(ctx.options, "base");
          if (file !== undefined) {
            try {
              const info = await lstat(file);
              if (!info.isFile() || info.size > 16384) throw new Error("Unbounded input");
              options.base = JSON.parse(await readFile(file, "utf8")) as LinearOwnershipSnapshot;
            } catch { throw new LinearOwnershipRefusal("invalid_input", "Pass a readable baseline JSON file of at most 16 KiB; preserve the reviewed observation format."); }
          }
          const mapping = readStringOption(ctx.options, "status-map");
          if (mapping !== undefined) options.statusMap = parseStatusMap(mapping);
          const budget = readStringOption(ctx.options, "max-output-bytes");
          if (budget !== undefined) options.maxOutputBytes = Number(budget);
          return await previewLinearOwnership(options, ctx.pm_root);
        } catch (error: unknown) {
          if (!(error instanceof LinearOwnershipRefusal)) throw error;
          return { ok: false, code: error.code, ...(error.field ? { field: error.field } : {}), remedy: error.remedy, remediation: error.remedy, exit_code: error.exitCode };
        }
      },
    });
    registerLinearCommand(api, {
      name: "linear closure",
      description: "Read the bounded missing Linear prerequisite frontier for selected linked items",
      intent: "Acquire prerequisite context without importing or mutating tracker or provider state",
      examples: ["pm linear closure --items pm-example --json", "pm linear closure --items pm-one,pm-two --max-depth 3 --max-nodes 32"],
      flags: [
        { long: "--items", value_name: "ids", description: "Explicit comma-separated existing linked pm item IDs (1..16)." },
        { long: "--max-depth", value_name: "n", description: "Prerequisite hops, 0..8 (default 3)." },
        { long: "--max-nodes", value_name: "n", description: "Unique acquired identities including selected roots, 1..128 (default 32)." },
        { long: "--max-requests", value_name: "n", description: "Actual HTTP attempts, 1..256 (default 64); no automatic retries." },
        { long: "--max-relations", value_name: "n", description: "Relation rows examined, 1..1024 (default 128)." },
        { long: "--max-output-bytes", value_name: "n", description: "Complete JSON receipt byte budget, 1024..131072 (default 16384)." },
      ],
      async run(ctx) {
        const options: LinearClosureOptions = { items: (readStringOption(ctx.options, "items") ?? "").split(",") };
        for (const [flag, key] of [["max-depth", "maxDepth"], ["max-nodes", "maxNodes"], ["max-requests", "maxRequests"],
          ["max-relations", "maxRelations"], ["max-output-bytes", "maxOutputBytes"]] as const) {
          const value = readStringOption(ctx.options, flag);
          if (value !== undefined) options[key] = Number(value);
        }
        return fetchLinearDependencyClosure(options, ctx.pm_root);
      },
    });
    registerLinearCommand(api, {
      name: "linear capture",
      description: "Propose revisioned evidence notes from one explicitly selected Linear thread",
      intent: "Preview selected discussion evidence; append a reviewed revision only with explicit apply",
      examples: ["pm linear capture --thread ROOT_ID --item ITEM_ID", "pm linear capture --thread ROOT_ID --item ITEM_ID --apply --revision TOKEN --json"],
      flags: [
        { long: "--thread", value_name: "id", description: "Explicit top-level Linear comment ID; includes only its direct replies." },
        { long: "--item", value_name: "id", description: "Existing pm item receiving the proposed evidence note." },
        { long: "--disclosure", value_name: "mode", description: "metadata (default) or text; text explicitly includes bodies and display names." },
        { long: "--apply", description: "Append one structured core note for the reviewed revision; never creates an item." },
        { long: "--revision", value_name: "token", description: "Reviewed preview token, required with --apply." },
        { long: "--max-output-bytes", value_name: "bytes", description: "Complete JSON receipt budget, 1024..65536 (default 8192)." },
      ],
      async run(ctx) {
        return captureLinearThread({
          threadId: readStringOption(ctx.options, "thread") ?? "",
          itemId: readStringOption(ctx.options, "item") ?? "",
          disclosure: (readStringOption(ctx.options, "disclosure") ?? "metadata") as "metadata" | "text",
          apply: readBooleanOption(ctx.options, "apply"),
          revision: readStringOption(ctx.options, "revision"),
          maxOutputBytes: ctx.options.maxOutputBytes === undefined && ctx.options["max-output-bytes"] === undefined
            ? undefined : Number(readStringOption(ctx.options, "max-output-bytes")),
        }, ctx.pm_root);
      },
    });
    // -----------------------------------------------------------------------
    // preflight — validate credentials + reachability before any Linear command
    // that REACHES Linear runs. Note "reaches", not "mutates": the gate protects
    // the network call, so `--atomic --dry-run` needs it (it fetches issues to
    // build the plan) while `export --push --dry-run` does not (it writes and
    // fetches nothing). See commandNeedsLinearAccess. Scoped to the command
    // paths pm-linear owns so it
    // cannot contend with another package's preflight override (an unscoped /
    // global override collides pairwise with every other installed package's
    // override; pm health reports extension_preflight_override_collision). On
    // failure it injects a sentinel option (it cannot abort by throwing) that
    // the handlers convert into a clean USAGE error.
    // -----------------------------------------------------------------------
    api.registerPreflight({
      commands: ["linear sync", "linear import", "linear export", "linear-sync import"],
      run: async (ctx: PreflightOverrideContext) => {
        if (!commandNeedsLinearAccess(ctx.command, ctx.options)) return {};
        // Reachability uses the network; allow opting out (CI/offline/tests).
        // pm strips a leading `--no-` as boolean negation, so the user-facing flag
        // is `--skip-preflight-network` (the legacy `no-preflight-network` key is
        // still honored for back-compat with any existing scripts/config).
        const checkReachability =
          !readBooleanOption(ctx.options, "skip-preflight-network") &&
          !readBooleanOption(ctx.options, "no-preflight-network") &&
          process.env["LINEAR_PREFLIGHT_NO_NETWORK"] !== "1";
        let sourceField: string | undefined;
        const error = await preflightLinear(checkReachability, (source) => { sourceField = source.field; });
        if (!error) return {};
        return { options: { ...ctx.options, [PREFLIGHT_ERROR_OPTION]: error, ...(sourceField ? { [PREFLIGHT_SOURCE_FIELD_OPTION]: sourceField } : {}) } };
      },
    });

    // -----------------------------------------------------------------------
    // Command: pm linear sync
    // -----------------------------------------------------------------------
    registerLinearCommand(api, {
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
        { long: "--schema-version", value_name: "version", description: "Require the reviewed schema version before local changes." },
        { long: "--atomic", description: "Commit the complete sync as one workspace-writer-locked, crash-resumable transaction (pm-cli >=2026.7.20); compensate applied mutations on failure and report incomplete compensation" },
        { long: "--dry-run", description: "Preview the exact GraphQL request without writes. Offline on its own; with --atomic it fetches issues to build the plan, so it needs LINEAR_API_KEY" },
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
          schemaVersion: readStringOption(ctx.options, "schema-version"),
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
              ...(result.schema ? { schema: result.schema } : {}),
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
            ...(result.schema ? { schema: result.schema } : {}),
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
    // Commands: schema negotiation and configuration diagnostics.
    // pm linear validate — readiness diagnostics. Reports whether the
    // API key + default team are configured WITHOUT leaking the key, and
    // whether push-on-write is enabled. Offline by default; --check-network
    // (opt-in) probes the Linear API. --json returns the structured object.
    // -----------------------------------------------------------------------
    registerLinearCommand(api, {
      name: "linear schema",
      description: "Negotiate a versioned Linear workflow mapping before sync",
      intent: "Inspect team settings, states and labels without writes",
      examples: ["pm linear schema --team ENG", "pm --json linear schema --team ENG"],
      flags: [
        { long: "--team", value_name: "slug", description: "Team key, or LINEAR_DEFAULT_TEAM." },
        { long: "--status-map", value_name: "map", description: "Linear state to registered pm status overrides." },
        { long: "--schema-version", value_name: "version", description: "Refuse if this previously negotiated version changed." },
      ],
      async run(ctx) {
        const selection = resolveTeamSelection(ctx.options);
        if (!selection) throw new LinearSchemaRefusal("mapping_invalid", "Pass --team or set LINEAR_DEFAULT_TEAM, then retry linear schema.");
        return negotiateLinearSchema({
          team: selection.team,
          statusMap: parseStatusMap(readStringOption(ctx.options, "status-map")),
          schemaVersion: readStringOption(ctx.options, "schema-version"),
        }, ctx.pm_root);
      },
    });
    registerLinearCommand(api, {
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
          const err = await preflightLinear(true);
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
    const linearImportFlags: Parameters<ExtensionApi["registerFlags"]>[1] = [
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
      { long: "--schema-version", value_name: "version", description: "Require the reviewed schema version before local changes." },
      { long: "--atomic", description: "Commit the complete import as one workspace-writer-locked, crash-resumable transaction (pm-cli >=2026.7.20); compensate applied mutations on failure and report incomplete compensation" },
      { long: "--dry-run", description: "Print the exact GraphQL request without writes. Offline on its own; with --atomic it fetches issues to build the plan, so it needs LINEAR_API_KEY." },
    ];
    for (const command of ["linear import", "linear-sync import"]) api.registerFlags(command, linearImportFlags);
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
    registerLinearImporter(api, "linear", async (ctx) => {
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
        schemaVersion: readStringOption(ctx.options, "schema-version"),
      };

      // --dry-run is fully offline: emit the literal GraphQL request, no call.
      // --atomic --dry-run shares the atomic prep/matching path (fetches issues,
      // reports counts, no commit) - handled inside syncLinearIssues.
      if (dryRun && !atomic) {
        const plan = await renderImportDryRun(ctx, syncOpts, teamSelection.source);
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
          ...(result.schema ? { schema: result.schema } : {}),
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
    registerLinearExporter(api, "linear", async (ctx) => {
      assertPreflightOk(ctx.options);
      const push = readBooleanOption(ctx.options, "push");
      const dryRun = readBooleanOption(ctx.options, "dry-run");
      const invertedStatusMap = invertStatusMap(
        parseStatusMap(readStringOption(ctx.options, "status-map"))
      );
      const teamSelection = resolveTeamSelection(ctx.options);
      const teamKey = teamSelection?.team;
      const fieldMap = parseFieldMap(readStringOption(ctx.options, "map"));
      const items = await readPmItems(ctx.pm_root);
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
            ? ownMappingValue(teamCtx.statesByName, stateName.trim().toLowerCase())
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
            // Only the error envelope is consumed here — the mutation's
            // `success`/`issue` payload is never read, so the data type is
            // honestly `unknown` rather than an invented schema mirror.
            const resp = await linearRequest<unknown>(apiKey, ISSUE_UPDATE_MUTATION, {
              id: payload.linearId,
              input,
            });
            if (resp.errors?.length) {
              throw new Error(
                `Linear issueUpdate failed: ${resp.errors.map((e) => e.message).join("; ")}`
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
          // Same contract as the update above: only `errors` is read.
          const resp = await linearRequest<unknown>(apiKey, ISSUE_CREATE_MUTATION, { input });
          if (resp.errors?.length) {
            throw new Error(
              `Linear issueCreate failed: ${resp.errors.map((e) => e.message).join("; ")}`
            );
          }
          created++;
        } catch (err) {
          if (err instanceof LinearSourceRefusal) throw err;
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
    registerLinearImporter(api, "linear-sync", async (ctx) => {
      // The deprecated alias reaches the same write path as `linear import`,
      // so it must clear the same credential gate. The runtime swallows throws
      // from a preflight override, which is why every mutating handler asserts
      // here rather than relying on the registration alone.
      assertPreflightOk(ctx.options);
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
        schemaVersion: readStringOption(ctx.options, "schema-version"),
      };

      // --dry-run is fully offline: emit the literal GraphQL request, no call
      // and no writes. --atomic --dry-run shares the atomic prep/matching path
      // (fetches issues, reports counts, no commit) handled inside
      // syncLinearIssues, so dryRun is forwarded below. Without this guard,
      // syncLinearIssues would see dryRun=false and turn a requested preview
      // into a real workspace write.
      if (dryRun && !atomic) {
        const plan = await renderImportDryRun(ctx, syncOpts, teamSelection.source);
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
        ...(result.schema ? { schema: result.schema } : {}),
        dryRun: Boolean(result.dryRun),
        ...(result.atomic ? { atomic: true } : {}),
        ...(result.transactionId !== undefined ? { transactionId: result.transactionId } : {}),
        ...(result.recovered !== undefined ? { recovered: result.recovered } : {}),
        ...(result.recoveredItems !== undefined ? { recoveredItems: result.recoveredItems } : {}),
      };
    });
  },
});
