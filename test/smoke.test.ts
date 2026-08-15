import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  commandNeedsLinearAccess,
  parseStatusMap,
  resolveStatus,
  buildProvenance,
  parseProvenance,
  itemToLinearPayload,
  invertStatusMap,
  resolveLinearStateName,
  buildIssuesQuery,
  indexItemsByLinearId,
  backoffDelayMs,
  parseFieldMap,
  fieldIsIgnored,
  resolvePmField,
  buildImportRequestPlan,
  buildItemPlan,
  buildExportMutationPlan,
  maskApiKey,
  mapPriorityToLinear,
  normalizeDueDate,
  resolveLabelIds,
  parseProjectMap,
  resolveProjectTag,
  parseEstimateTag,
  parseCycleTag,
  isReservedExportTag,
  resolveCycleId,
  applyPushDynamicFields,
  resetCycleWarning,
  resolveTeamSelection,
  AuthHttpError,
  normalizeCycleFilter,
} from "../index.ts";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

// ---------------------------------------------------------------------------
// Activation proof: drive the extension through pm's REAL registration
// validation and activation engine via createExtensionTestHarness, so a host
// rejection (e.g. a host-owned flag collision that aborts command registration)
// fails this suite instead of staying green against a hand-rolled api double.
// ---------------------------------------------------------------------------

let linearHarness: ExtensionTestHarness;

test("extension activates cleanly and registers expected capabilities", async () => {
  linearHarness = await createExtensionTestHarness(extension, {
    name: "pm-linear",
    capabilities: ["commands", "schema", "importers", "preflight"],
  });
  assert.deepEqual(linearHarness.activation.failed, [], "activation must not fail");
  // sync + validate commands
  linearHarness.assertCommandContract({ command: "linear sync" });
  linearHarness.assertCommandContract({ command: "linear validate" });
  // schema item fields
  linearHarness.assertItemField({ field: "linear_id", type: "string" });
  linearHarness.assertItemField({ field: "linear_url", type: "string" });
  // native + legacy importers, exporter, preflight guard, importer/exporter flags
  linearHarness.assertImporter({ importer: "linear" });
  linearHarness.assertImporter({ importer: "linear-sync" });
  linearHarness.assertExporter({ exporter: "linear" });
  linearHarness.assertPreflightOverride();
  linearHarness.assertFlags({ targetCommand: "linear import", flags: ["--team", "--dry-run"] });
  linearHarness.assertFlags({ targetCommand: "linear export", flags: ["--push", "--dry-run"] });
});

test("preflight override is scoped to pm-linear's owned command paths", async () => {
  // The override MUST register as a scoped object (commands + run), not a bare
  // function: a global (unscoped) override collides pairwise with every other
  // installed package's preflight override (pm health reports
  // extension_preflight_override_collision). The runtime matches a command
  // against `commands` by exact normalized path, so the array lists the full
  // command paths commandNeedsLinearAccess can require credentials for.
  const override = linearHarness.assertPreflightOverride();
  assert.deepEqual(
    override.commands,
    ["linear sync", "linear import", "linear export", "linear-sync import"],
    "preflight override must be scoped to exactly pm-linear's owned mutating command paths",
  );
  assert.equal(
    typeof override.run,
    "function",
    "scoped preflight override must expose a run function",
  );
  // Bind the scope to the classifier, in BOTH directions. A loop that only walks
  // `override.commands` cannot detect the drift that matters most: a command the
  // classifier says needs credentials while the scope omits it, which silently
  // loses its credential gate. So the invocations are enumerated explicitly with
  // their expected verdict, and the two sets are checked against each other.
  //
  // The `--dry-run` rows are the ones that were wrong before: `export --push
  // --dry-run` is documented as making no network call yet demanded a key, and
  // `--atomic --dry-run` does fetch issues yet skipped the preflight entirely.
  const invocations: ReadonlyArray<readonly [string, Record<string, unknown>, boolean]> = [
    ["linear sync", {}, true],
    ["linear sync", { "dry-run": true }, false],
    ["linear sync", { "dry-run": true, atomic: true }, true],
    ["linear import", {}, true],
    ["linear import", { "dry-run": true }, false],
    ["linear import", { "dry-run": true, atomic: true }, true],
    ["linear-sync import", {}, true],
    ["linear-sync import", { "dry-run": true }, false],
    ["linear-sync import", { "dry-run": true, atomic: true }, true],
    ["linear export", {}, false],
    ["linear export", { push: true }, true],
    ["linear export", { push: true, "dry-run": true }, false],
    ["linear export", { "dry-run": true }, false],
  ];
  const scope = new Set(override.commands ?? []);
  for (const [command, options, needsAccess] of invocations) {
    assert.strictEqual(
      commandNeedsLinearAccess(command, options),
      needsAccess,
      `commandNeedsLinearAccess(${command}, ${JSON.stringify(options)}) must be ${needsAccess}`,
    );
    if (needsAccess) {
      assert.ok(
        scope.has(command),
        `${command} needs Linear credentials but is missing from the preflight scope, so it would run with no credential gate`,
      );
    }
  }
  // ...and the other direction: every scoped command must appear above, so a
  // newly scoped command cannot sit here with no stated expectation.
  const covered = new Set(invocations.map(([command]) => command));
  assert.deepEqual(
    [...scope].filter((command) => !covered.has(command)),
    [],
    "every command in the preflight scope must have an expected classifier verdict declared above",
  );
});

test("parseStatusMap preserves original key casing and ignores junk", () => {
  assert.deepEqual(parseStatusMap(undefined), {});
  assert.deepEqual(parseStatusMap(""), {});
  // Keys keep their ORIGINAL casing (matching is done case-insensitively at
  // lookup time); this is what lets the export preview echo "Backlog"/"In Review".
  assert.deepEqual(
    parseStatusMap("In Review=in_progress,Backlog=open"),
    { "In Review": "in_progress", Backlog: "open" }
  );
  // missing "=" segments are skipped
  assert.deepEqual(parseStatusMap("garbage,Done=closed"), { Done: "closed" });
  // a case-insensitive key collision keeps the most recent original-case spelling
  assert.deepEqual(parseStatusMap("Backlog=open,backlog=closed"), { backlog: "closed" });
});

test("resolveStatus prefers the status map over the heuristic", () => {
  const map = parseStatusMap("In Review=blocked");
  assert.equal(resolveStatus("started", "In Review", map), "blocked");
  // falls back to the built-in heuristic when no override matches
  assert.equal(resolveStatus("started", "In Progress", map), "in_progress");
  assert.equal(resolveStatus("completed", "Done", {}), "closed");
  assert.equal(resolveStatus("unstarted", "Backlog", {}), "open");
});

test("buildProvenance + parseProvenance round-trip", () => {
  const issue = { id: "uuid-123", identifier: "ENG-7", url: "https://linear.app/x/issue/ENG-7" };
  const desc = buildProvenance(issue);
  const parsed = parseProvenance(desc);
  assert.ok(parsed, "provenance should parse back");
  assert.equal(parsed!.linear_id, "uuid-123");
  assert.equal(parsed!.linear_url, "https://linear.app/x/issue/ENG-7");
  // non-provenance descriptions return undefined
  assert.equal(parseProvenance("just a normal description"), undefined);
  assert.equal(parseProvenance(undefined), undefined);
});

test("buildProvenance falls back to a synthesized url", () => {
  const desc = buildProvenance({ id: "abc", identifier: "ENG-9" });
  const parsed = parseProvenance(desc);
  assert.equal(parsed!.linear_url, "https://linear.app/issue/ENG-9");
});

test("itemToLinearPayload maps fields and flags linked items", () => {
  const linked = itemToLinearPayload({
    id: "pm-1",
    title: "Fix login",
    body: "details",
    description: buildProvenance({ id: "lin-1", identifier: "ENG-1" }),
  });
  assert.equal(linked.title, "Fix login");
  assert.equal(linked.description, "details");
  assert.equal(linked.alreadyInLinear, true);

  const fresh = itemToLinearPayload({ id: "pm-2", title: "New", description: "plain" });
  assert.equal(fresh.alreadyInLinear, false);
  assert.equal(fresh.description, "plain");

  const untitled = itemToLinearPayload({});
  assert.equal(untitled.title, "(untitled)");
});

test("itemToLinearPayload does not export provenance as the issue description", () => {
  const payload = itemToLinearPayload({
    id: "pm-1",
    title: "Linked",
    description: buildProvenance({ id: "lin-1", identifier: "ENG-1" }),
  });

  assert.equal(payload.alreadyInLinear, true);
  assert.equal(payload.description, "");
});

test("itemToLinearPayload carries linear id + pm status for idempotent push", () => {
  const linked = itemToLinearPayload({
    id: "pm-1",
    title: "Fix login",
    status: "in_progress",
    description: buildProvenance({ id: "lin-1", identifier: "ENG-1" }),
  });
  assert.equal(linked.linearId, "lin-1");
  assert.equal(linked.pmStatus, "in_progress");
  assert.equal(linked.alreadyInLinear, true);
});

test("invertStatusMap + resolveLinearStateName map pm status -> Linear state", () => {
  // Default mapping (no overrides).
  assert.equal(resolveLinearStateName("open", {}), "Todo");
  assert.equal(resolveLinearStateName("in_progress", {}), "In Progress");
  assert.equal(resolveLinearStateName("closed", {}), "Done");
  assert.equal(resolveLinearStateName(undefined, {}), undefined);

  // A user --status-map "Backlog=open" inverts to open -> Backlog and wins.
  // The Linear state name keeps its ORIGINAL casing ("Backlog", not "backlog").
  const inverted = invertStatusMap(parseStatusMap("Backlog=open,In Review=in_progress"));
  assert.equal(inverted["open"], "Backlog", "original casing preserved on invert");
  assert.equal(inverted["in_progress"], "In Review");
  assert.equal(resolveLinearStateName("open", inverted), "Backlog");
  // statuses not in the map fall back to the default.
  assert.equal(resolveLinearStateName("closed", inverted), "Done");
});

test("buildIssuesQuery includes only requested filter clauses + variables", () => {
  const base = buildIssuesQuery({});
  assert.ok(base.includes("team: { key: { eq: $team } }"));
  assert.ok(!base.includes("$project"), "no project var when not requested");
  assert.ok(!base.includes("assignee: {"), "no assignee clause when not requested");

  const full = buildIssuesQuery({ project: true, assignee: true, label: true });
  assert.ok(full.includes("$project: String!"));
  assert.ok(full.includes("project: { name: { eq: $project } }"));
  assert.ok(full.includes("assignee: { email: { eq: $assignee } }"));
  assert.ok(full.includes("labels: { some: { name: { eq: $label } } }"));
  // The selection set always requests assignee so client-side use works.
  assert.ok(full.includes("assignee { name email }"));
});

test("indexItemsByLinearId keys items by stored linear id, ignoring unlinked", () => {
  const items = [
    { id: "pm-1", description: buildProvenance({ id: "lin-A", identifier: "ENG-1" }) },
    { id: "pm-2", description: "plain, no provenance" },
    { id: "pm-3", description: buildProvenance({ id: "lin-B", identifier: "ENG-2" }) },
  ];
  const index = indexItemsByLinearId(items);
  assert.equal(Object.keys(index).length, 2);
  assert.equal(index["lin-A"].id, "pm-1");
  assert.equal(index["lin-B"].id, "pm-3");
  assert.equal(index["lin-missing"], undefined);
});

test("backoffDelayMs grows exponentially and honors Retry-After", () => {
  assert.equal(backoffDelayMs(0), 250);
  assert.equal(backoffDelayMs(1), 500);
  assert.equal(backoffDelayMs(2), 1000);
  // capped at 8s
  assert.equal(backoffDelayMs(10), 8000);
  // explicit retry-after wins
  assert.equal(backoffDelayMs(0, 4200), 4200);
});

test("buildIssuesQuery includes the updated-since clause when requested", () => {
  const q = buildIssuesQuery({ updatedSince: true });
  assert.ok(q.includes("updatedAt: { gte: $updatedSince }"));
  assert.ok(q.includes("$updatedSince: DateTimeOrDuration!"));
  const base = buildIssuesQuery({});
  assert.ok(!base.includes("$updatedSince"), "absent when not requested");
});

test("buildIssuesQuery filters by state server-side when requested", () => {
  const q = buildIssuesQuery({ state: true });
  // The state constraint must live in the GraphQL filter (server-side), not be
  // applied client-side after fetching `--limit` issues, otherwise large teams
  // under-return matches that page beyond the fetched window.
  assert.ok(q.includes("state: { name: { containsIgnoreCase: $state } }"));
  assert.ok(q.includes("$state: String!"));
  const base = buildIssuesQuery({});
  assert.ok(!base.includes("$state"), "no state var when not requested");
  assert.ok(!base.includes("state: { name:"), "no state clause when not requested");
});

test("resolveTeamSelection prefers --team and falls back to LINEAR_DEFAULT_TEAM", () => {
  assert.deepEqual(
    resolveTeamSelection({ team: " ENG " }, "OPS"),
    { team: "ENG", source: "flag" }
  );
  assert.deepEqual(
    resolveTeamSelection({ team: "   " }, " ops "),
    { team: "ops", source: "env" }
  );
  assert.equal(resolveTeamSelection({}, "  "), undefined);
  assert.equal(resolveTeamSelection({ team: "   " }, undefined), undefined);
});

test("parseFieldMap / fieldIsIgnored / resolvePmField", () => {
  assert.deepEqual(parseFieldMap(undefined), {});
  assert.deepEqual(parseFieldMap("Identifier=ignore,Priority=Custom"), {
    identifier: "ignore",
    priority: "custom",
  });
  const map = parseFieldMap("identifier=ignore,labels=tags");
  assert.equal(fieldIsIgnored(map, "identifier"), true);
  assert.equal(fieldIsIgnored(map, "title"), false);
  // override (non-ignore) returns the mapped pm field
  assert.equal(resolvePmField(map, "labels"), "tags");
  // ignore is treated as "no remap" by resolvePmField (the ignore is a suppress)
  assert.equal(resolvePmField(map, "identifier"), "identifier");
  // unmapped fields default to themselves
  assert.equal(resolvePmField(map, "title"), "title");
});

test("buildImportRequestPlan builds the literal request with only used vars", () => {
  const plan = buildImportRequestPlan("eng", 50);
  assert.equal(plan.endpoint, "https://api.linear.app/graphql");
  assert.equal(plan.method, "POST");
  assert.equal(plan.variables.team, "ENG", "team is upper-cased");
  assert.equal(plan.variables.first, 50);
  assert.equal(plan.variables.after, null);
  assert.ok(!("project" in plan.variables), "no project var when unused");

  const full = buildImportRequestPlan("ENG", 999, {
    project: "Q3",
    assignee: "a@b.com",
    label: "bug",
    updatedSince: "2026-01-01",
  });
  // limit is capped at the page size (250)
  assert.equal(full.variables.first, 250);
  assert.equal(full.variables.project, "Q3");
  assert.equal(full.variables.assignee, "a@b.com");
  assert.equal(full.variables.label, "bug");
  assert.equal(full.variables.updatedSince, "2026-01-01");
  assert.ok(full.query.includes("updatedAt: { gte: $updatedSince }"));
  // state absent above -> no state var/clause (zero regression for callers that
  // do not pass --state)
  assert.ok(!("state" in full.variables), "no state var when --state absent");
  assert.ok(!full.query.includes("$state"), "no state clause when --state absent");
});

test("buildImportRequestPlan wires --state into the server-side filter", () => {
  const plan = buildImportRequestPlan("ENG", 100, { state: "In Progress" });
  assert.equal(plan.variables.state, "In Progress");
  assert.ok(plan.query.includes("state: { name: { containsIgnoreCase: $state } }"));
  assert.ok(plan.query.includes("$state: String!"));
  // whitespace-only / absent state adds nothing
  const blank = buildImportRequestPlan("ENG", 100, { state: "   " });
  assert.ok(!("state" in blank.variables), "blank state is not a filter");
  assert.ok(!blank.query.includes("$state"), "blank state adds no clause");
});

const SAMPLE_ISSUE = {
  id: "lin-1",
  identifier: "ENG-1",
  title: "Fix login",
  description: "details",
  priority: 1,
  estimate: 5,
  state: { name: "In Progress", type: "started" },
  labels: { nodes: [{ name: "bug" }, { name: "p0" }] },
  dueDate: "2026-07-01",
  cycle: null,
  customer: { name: "Acme" },
  url: "https://linear.app/x/issue/ENG-1",
};

test("buildItemPlan maps a Linear issue to resolved pm fields", () => {
  const plan = buildItemPlan(SAMPLE_ISSUE as any, {});
  assert.equal(plan.title, "[ENG-1] Fix login");
  assert.equal(plan.body, "details");
  assert.equal(plan.status, "in_progress");
  assert.equal(plan.priority, 1);
  assert.deepEqual(plan.tags, ["bug", "p0", "estimate:5", "customer:Acme"]);
  assert.equal(plan.deadline, "2026-07-01");
  assert.ok(plan.description.includes("linear_id=lin-1"));
});

test("buildItemPlan honors --map field suppression and status-map", () => {
  const fieldMap = parseFieldMap("identifier=ignore,priority=ignore,labels=ignore");
  const plan = buildItemPlan(SAMPLE_ISSUE as any, {}, fieldMap);
  assert.equal(plan.title, "Fix login", "identifier prefix dropped");
  assert.equal(plan.priority, 3, "priority suppressed -> default medium");
  assert.deepEqual(plan.tags, ["estimate:5", "customer:Acme"], "labels suppressed independently");
  // status-map still wins for status
  const statusMap = parseStatusMap("In Progress=blocked");
  const plan2 = buildItemPlan(SAMPLE_ISSUE as any, statusMap);
  assert.equal(plan2.status, "blocked");
});

test("buildExportMutationPlan: linked item -> issueUpdate, fresh -> issueCreate", () => {
  const linked = buildExportMutationPlan(
    { title: "T", description: "D", pmStatus: "in_progress", alreadyInLinear: true, linearId: "lin-9" },
    {}
  );
  assert.equal(linked.action, "update");
  assert.ok(linked.mutation.includes("issueUpdate"));
  assert.equal((linked.variables as any).id, "lin-9");
  assert.equal(linked.targetStateName, "In Progress");
  assert.equal(((linked.variables as any).input).stateName, "In Progress");

  const fresh = buildExportMutationPlan(
    { title: "New", description: "", pmStatus: "open", alreadyInLinear: false },
    {},
    "eng"
  );
  assert.equal(fresh.action, "create");
  assert.ok(fresh.mutation.includes("issueCreate"));
  assert.equal(((fresh.variables as any).input).teamId, "<resolved-id-for-ENG>");
  assert.equal(fresh.targetStateName, "Todo");
});

test("mapPriorityToLinear is the inverse of the import priority mapping", () => {
  // pm 1..4 maps 1:1 onto Linear 1..4.
  assert.equal(mapPriorityToLinear(1), 1);
  assert.equal(mapPriorityToLinear(2), 2);
  assert.equal(mapPriorityToLinear(3), 3);
  assert.equal(mapPriorityToLinear(4), 4);
  // anything else -> 0 ("No priority"), never a bogus int.
  assert.equal(mapPriorityToLinear(undefined), 0);
  assert.equal(mapPriorityToLinear(0), 0);
  assert.equal(mapPriorityToLinear(99), 0);
});

test("normalizeDueDate slices an ISO datetime to a bare date", () => {
  assert.equal(normalizeDueDate("2026-08-01T00:00:00.000Z"), "2026-08-01");
  assert.equal(normalizeDueDate("2026-08-01"), "2026-08-01");
  assert.equal(normalizeDueDate(undefined), undefined);
  assert.equal(normalizeDueDate(""), undefined);
  assert.equal(normalizeDueDate("not-a-date"), undefined);
});

test("resolveLabelIds maps tag names to existing label ids, dropping unknowns", () => {
  const byName = { bug: "lbl-1", "p0": "lbl-2" };
  assert.deepEqual(resolveLabelIds(["bug", "P0"], byName), ["lbl-1", "lbl-2"]);
  // unknown tags are dropped, no throw
  assert.deepEqual(resolveLabelIds(["bug", "nope"], byName), ["lbl-1"]);
  assert.deepEqual(resolveLabelIds([], byName), []);
  assert.deepEqual(resolveLabelIds(undefined, byName), []);
  // de-duplicated when two names resolve to the same id
  assert.deepEqual(resolveLabelIds(["bug", "bug"], byName), ["lbl-1"]);
});

test("itemToLinearPayload carries priority, labels, and dueDate (export symmetry)", () => {
  const p = itemToLinearPayload({
    id: "pm-1",
    title: "Ship it",
    priority: 2,
    tags: ["bug", "p0"],
    deadline: "2026-09-15T00:00:00.000Z",
  });
  assert.equal(p.priority, 2);
  assert.deepEqual(p.labels, ["bug", "p0"]);
  assert.equal(p.dueDate, "2026-09-15");

  // No deadline => dueDate omitted; no tags => empty label list; no priority => 0.
  const bare = itemToLinearPayload({ id: "pm-2", title: "Bare" });
  assert.equal(bare.priority, 0);
  assert.deepEqual(bare.labels, []);
  assert.equal(bare.dueDate, undefined);
});

test("buildExportMutationPlan now includes priority, labels (labelIds + labelNames), and dueDate", () => {
  const fresh = buildExportMutationPlan(
    {
      title: "New",
      description: "",
      pmStatus: "open",
      priority: 1,
      labels: ["bug", "urgent"],
      dueDate: "2026-10-01",
      alreadyInLinear: false,
    },
    {},
    "eng"
  );
  const input = (fresh.variables as any).input;
  assert.equal(input.priority, 1, "priority present in create input");
  assert.deepEqual(input.labelNames, ["bug", "urgent"], "label names passed through");
  assert.ok(Array.isArray(input.labelIds) && input.labelIds.length === 2, "labelIds placeholder present");
  assert.ok(String(input.labelIds[0]).includes("bug"), "labelId placeholder names the label");
  assert.equal(input.dueDate, "2026-10-01", "dueDate present in create input");

  // update path carries them too
  const linked = buildExportMutationPlan(
    {
      title: "T",
      description: "D",
      pmStatus: "in_progress",
      priority: 3,
      labels: ["feature"],
      dueDate: "2026-11-02",
      alreadyInLinear: true,
      linearId: "lin-9",
    },
    {}
  );
  const upInput = (linked.variables as any).input;
  assert.equal(upInput.priority, 3);
  assert.deepEqual(upInput.labelNames, ["feature"]);
  assert.equal(upInput.dueDate, "2026-11-02");

  // priority 0 (no priority) is still explicitly present (valid clear); no
  // labels/dueDate => those keys omitted.
  const minimal = buildExportMutationPlan(
    { title: "Min", description: "", pmStatus: "open", priority: 0, labels: [], alreadyInLinear: false },
    {},
    "eng"
  );
  const minInput = (minimal.variables as any).input;
  assert.equal(minInput.priority, 0, "priority 0 still present");
  assert.ok(!("labelIds" in minInput), "no labelIds when no labels");
  assert.ok(!("labelNames" in minInput), "no labelNames when no labels");
  assert.ok(!("dueDate" in minInput), "no dueDate when none set");
});

test("parseProjectMap distinguishes absent / passthrough / explicit map", () => {
  assert.deepEqual(parseProjectMap(undefined), { enabled: false, passthrough: false, map: {} });
  // bare flag / "*" / "true" => passthrough
  assert.deepEqual(parseProjectMap(""), { enabled: true, passthrough: true, map: {} });
  assert.deepEqual(parseProjectMap("*"), { enabled: true, passthrough: true, map: {} });
  assert.deepEqual(parseProjectMap("true"), { enabled: true, passthrough: true, map: {} });
  // explicit pairs (case-insensitive keys)
  const explicit = parseProjectMap("Mobile App=mobile,Web=web");
  assert.equal(explicit.enabled, true);
  assert.equal(explicit.passthrough, false);
  assert.deepEqual(explicit.map, { "mobile app": "mobile", web: "web" });
  // junk-only value still enables (passthrough), never a silent no-op
  assert.deepEqual(parseProjectMap("garbage"), { enabled: true, passthrough: true, map: {} });
});

test("resolveProjectTag maps, passes through, and ignores per spec", () => {
  const off = parseProjectMap(undefined);
  assert.equal(resolveProjectTag("Mobile App", off), undefined, "disabled => no tag");

  const pass = parseProjectMap("");
  assert.equal(resolveProjectTag("Mobile App", pass), "Mobile App", "passthrough verbatim");
  assert.equal(resolveProjectTag(null, pass), undefined, "no project => no tag");
  assert.equal(resolveProjectTag(undefined, pass), undefined);

  const map = parseProjectMap("Mobile App=mobile,Legacy=ignore");
  assert.equal(resolveProjectTag("Mobile App", map), "mobile", "explicit remap");
  assert.equal(resolveProjectTag("Legacy", map), undefined, "ignore suppresses");
  assert.equal(resolveProjectTag("Unmapped", map), "Unmapped", "partial map falls back to own name");
});

test("buildItemPlan appends the project tag (additive, de-duplicated)", () => {
  const issueWithProject = { ...SAMPLE_ISSUE, project: { name: "Mobile App" } };
  // passthrough adds the verbatim project name on top of label tags
  const plan = buildItemPlan(issueWithProject as any, {}, {}, parseProjectMap(""));
  assert.deepEqual(plan.tags, ["bug", "p0", "Mobile App", "estimate:5", "customer:Acme"]);

  // explicit remap
  const plan2 = buildItemPlan(issueWithProject as any, {}, {}, parseProjectMap("Mobile App=mobile"));
  assert.deepEqual(plan2.tags, ["bug", "p0", "mobile", "estimate:5", "customer:Acme"]);

  // disabled => unchanged (existing behavior)
  const plan3 = buildItemPlan(issueWithProject as any, {});
  assert.deepEqual(plan3.tags, ["bug", "p0", "estimate:5", "customer:Acme"]);

  // de-dup: a project tag equal to an existing label is not duplicated
  const issueDup = { ...SAMPLE_ISSUE, project: { name: "bug" } };
  const plan4 = buildItemPlan(issueDup as any, {}, {}, parseProjectMap(""));
  assert.deepEqual(plan4.tags, ["bug", "p0", "estimate:5", "customer:Acme"]);
});

test("status-map export preview preserves original Linear state-name casing", () => {
  // Regression: parseStatusMap used to lower-case keys, so invertStatusMap
  // echoed "backlog"/"in review" as the target state name. Now the original
  // casing round-trips.
  const inverted = invertStatusMap(
    parseStatusMap("Backlog=open,In Review=in_progress")
  );
  assert.equal(resolveLinearStateName("open", inverted), "Backlog");
  assert.equal(resolveLinearStateName("in_progress", inverted), "In Review");

  // The export mutation plan (what the preview prints as targetStateName) uses
  // the same path, so it must also carry the original casing.
  const plan = buildExportMutationPlan(
    { title: "T", description: "", pmStatus: "open", alreadyInLinear: false },
    inverted,
    "eng"
  );
  assert.equal(plan.targetStateName, "Backlog");
  assert.equal((plan.variables as any).input.stateName, "Backlog");

  // Default map (no --status-map) still yields the canonical "Todo"/"In Progress".
  assert.equal(resolveLinearStateName("open", {}), "Todo");
  assert.equal(resolveLinearStateName("in_progress", {}), "In Progress");
  const def = buildExportMutationPlan(
    { title: "T", description: "", pmStatus: "in_progress", alreadyInLinear: false },
    {},
    "eng"
  );
  assert.equal(def.targetStateName, "In Progress");

  // Matching remains case-insensitive on the Linear side: a differently-cased
  // state name still resolves the override.
  const map = parseStatusMap("In Review=blocked");
  assert.equal(resolveStatus("started", "in review", map), "blocked");
  assert.equal(resolveStatus("started", "IN REVIEW", map), "blocked");
});

test("buildItemPlan persists assignee (email preferred) and cycle as a tag", () => {
  const issue = {
    ...SAMPLE_ISSUE,
    assignee: { name: "Ada Lovelace", email: "ada@acme.com" },
    cycle: { name: "Sprint 7" },
  };
  const plan = buildItemPlan(issue as any, {});
  assert.equal(plan.assignee, "ada@acme.com", "email preferred over name");
  assert.ok(plan.tags.includes("cycle:Sprint 7"), "cycle persisted as a namespaced tag");
  // label tags preserved alongside the cycle tag
  assert.ok(plan.tags.includes("bug") && plan.tags.includes("p0"));

  // Falls back to the display name when there is no email.
  const nameOnly = buildItemPlan(
    { ...SAMPLE_ISSUE, assignee: { name: "Grace Hopper", email: null }, cycle: null } as any,
    {}
  );
  assert.equal(nameOnly.assignee, "Grace Hopper");
  assert.ok(!nameOnly.tags.some((t) => t.startsWith("cycle:")), "no cycle tag when unassigned cycle");
});

test("buildItemPlan: unassigned issue and no cycle => no assignee, no cycle tag", () => {
  const plan = buildItemPlan(
    { ...SAMPLE_ISSUE, assignee: null, cycle: null } as any,
    {}
  );
  assert.equal(plan.assignee, undefined);
  assert.ok(!plan.tags.some((t) => t.startsWith("cycle:")));
});

test("buildItemPlan: --map suppresses assignee, labels, estimate, and customer independently", () => {
  const issue = {
    ...SAMPLE_ISSUE,
    assignee: { name: "Ada", email: "ada@acme.com" },
    cycle: { name: "Sprint 7" },
    estimate: 8,
    customer: { name: "Globex" },
  };
  const noAssignee = buildItemPlan(issue as any, {}, parseFieldMap("assignee=ignore"));
  assert.equal(noAssignee.assignee, undefined, "assignee suppressed");
  assert.ok(noAssignee.tags.includes("cycle:Sprint 7"), "cycle still tagged");
  assert.ok(noAssignee.tags.includes("estimate:8"), "estimate still tagged");
  assert.ok(noAssignee.tags.includes("customer:Globex"), "customer still tagged");

  // labels=ignore drops ALL tags (including the cycle tag, which is tag-encoded).
  const noLabels = buildItemPlan(issue as any, {}, parseFieldMap("labels=ignore"));
  assert.deepEqual(noLabels.tags, ["estimate:8", "customer:Globex"]);
  assert.equal(noLabels.assignee, "ada@acme.com", "assignee unaffected by labels=ignore");

  const noEstimateCustomer = buildItemPlan(
    issue as any,
    {},
    parseFieldMap("estimate=ignore,customer=ignore")
  );
  assert.ok(!noEstimateCustomer.tags.some((t) => t.startsWith("estimate:")));
  assert.ok(!noEstimateCustomer.tags.some((t) => t.startsWith("customer:")));
});

test("buildItemPlan: cycle tag is de-duplicated against an identical label", () => {
  const issue = {
    ...SAMPLE_ISSUE,
    labels: { nodes: [{ name: "cycle:Sprint 7" }] },
    cycle: { name: "Sprint 7" },
  };
  const plan = buildItemPlan(issue as any, {});
  const cycleTags = plan.tags.filter((t) => t === "cycle:Sprint 7");
  assert.equal(cycleTags.length, 1, "cycle tag not duplicated");
});

test("maskApiKey never leaks the full key", () => {
  assert.equal(maskApiKey(undefined), "");
  assert.equal(maskApiKey(""), "");
  const masked = maskApiKey("lin_api_supersecretvalue");
  assert.ok(masked.startsWith("lin_"));
  assert.ok(!masked.includes("supersecret"), "must not contain the secret tail");
  assert.ok(masked.includes("chars"));
});

// ---------------------------------------------------------------------------
// Export round-trip: Linear estimate + cycle
// ---------------------------------------------------------------------------

test("parseEstimateTag extracts the integer estimate from estimate:<n> tags", () => {
  assert.equal(parseEstimateTag(["bug", "estimate:5"]), 5);
  assert.equal(parseEstimateTag(["estimate:0"]), 0, "0 is a valid explicit estimate");
  assert.equal(parseEstimateTag(["ESTIMATE:8"]), 8, "case-insensitive prefix");
  assert.equal(parseEstimateTag(["no", "tags"]), undefined, "absent => undefined");
  assert.equal(parseEstimateTag(["estimate:abc"]), undefined, "non-numeric => skipped");
  assert.equal(parseEstimateTag(["estimate:2", "estimate:7"]), 7, "last well-formed wins");
});

test("parseCycleTag extracts the cycle name from cycle:<name> tags", () => {
  assert.equal(parseCycleTag(["bug", "cycle:Q3"]), "Q3");
  assert.equal(parseCycleTag(["cycle:Sprint 7"]), "Sprint 7", "names with spaces preserved");
  assert.equal(parseCycleTag(["CYCLE:Q1"]), "Q1", "case-insensitive prefix");
  assert.equal(parseCycleTag(["nope"]), undefined, "absent => undefined");
  assert.equal(parseCycleTag(["cycle:"]), undefined, "empty name => undefined");
});

test("isReservedExportTag flags estimate:/cycle: tags only", () => {
  assert.equal(isReservedExportTag("estimate:5"), true);
  assert.equal(isReservedExportTag("cycle:Q3"), true);
  assert.equal(isReservedExportTag("Estimate:5"), true, "case-insensitive");
  assert.equal(isReservedExportTag("bug"), false);
  assert.equal(isReservedExportTag("customer:Acme"), false, "customer is not promoted on export");
});

test("itemToLinearPayload: estimate:5 tag surfaces as payload.estimate and is NOT a label", () => {
  const p = itemToLinearPayload({
    id: "pm-1",
    title: "Pointed",
    tags: ["bug", "estimate:5", "cycle:Q3"],
  });
  assert.equal(p.estimate, 5, "estimate promoted to first-class field");
  assert.equal(p.cycleName, "Q3", "cycle promoted to first-class field");
  assert.deepEqual(p.labels, ["bug"], "estimate:/cycle: tags excluded from labels");
});

test("buildExportMutationPlan includes estimate + cycleId placeholder (create + update)", () => {
  const fresh = buildExportMutationPlan(
    {
      title: "New",
      description: "",
      pmStatus: "open",
      priority: 1,
      estimate: 5,
      cycleName: "Q3",
      alreadyInLinear: false,
    },
    {},
    "eng"
  );
  const input = (fresh.variables as any).input;
  assert.equal(input.estimate, 5, "estimate present in create input");
  assert.equal(input.cycleName, "Q3", "cycle name carried in offline plan");
  assert.ok(String(input.cycleId).includes("Q3"), "cycleId placeholder names the cycle");

  const linked = buildExportMutationPlan(
    {
      title: "T",
      description: "D",
      pmStatus: "in_progress",
      estimate: 0,
      cycleName: "Sprint 7",
      alreadyInLinear: true,
      linearId: "lin-9",
    },
    {}
  );
  const up = (linked.variables as any).input;
  assert.equal(up.estimate, 0, "estimate 0 still present (valid explicit value)");
  assert.ok(String(up.cycleId).includes("Sprint 7"));
});

test("applyPushDynamicFields sets estimate + resolved cycleId from a mocked map", () => {
  resetCycleWarning();
  const cyclesByName = { q3: "cyc-123" };
  const input: Record<string, unknown> = {};
  const warnings: string[] = [];
  applyPushDynamicFields(
    input,
    { title: "x", description: "", estimate: 5, cycleName: "Q3", alreadyInLinear: false } as any,
    cyclesByName,
    (m: string) => warnings.push(m)
  );
  assert.equal(input.estimate, 5);
  assert.equal(input.cycleId, "cyc-123", "named cycle resolved to its id");
  assert.equal(warnings.length, 0, "no warning when cycle resolves");
});

test("applyPushDynamicFields skips an unresolvable cycle without throwing, warns once", () => {
  resetCycleWarning();
  const warnings: string[] = [];
  const a: Record<string, unknown> = {};
  assert.doesNotThrow(() =>
    applyPushDynamicFields(
      a,
      { title: "x", description: "", cycleName: "Ghost", alreadyInLinear: false } as any,
      {},
      (m: string) => warnings.push(m)
    )
  );
  assert.ok(!("cycleId" in a), "unresolved cycle => cycleId omitted");
  assert.equal(warnings.length, 1, "warned once");

  // A second unresolved cycle in the same process is suppressed.
  const b: Record<string, unknown> = {};
  applyPushDynamicFields(
    b,
    { title: "y", description: "", cycleName: "AlsoGhost", alreadyInLinear: false } as any,
    {},
    (m: string) => warnings.push(m)
  );
  assert.equal(warnings.length, 1, "subsequent unresolved cycles suppressed");
});

test("--map estimate=ignore omits estimate; cycle=ignore omits cycle", () => {
  const noEstimate = itemToLinearPayload(
    { id: "pm-1", title: "x", tags: ["estimate:5", "cycle:Q3"] },
    parseFieldMap("estimate=ignore")
  );
  assert.equal(noEstimate.estimate, undefined, "estimate suppressed by --map");
  assert.equal(noEstimate.cycleName, "Q3", "cycle still present");
  // suppressed estimate tag is still stripped from labels (not re-emitted)
  assert.ok(!noEstimate.labels?.some((t) => t.startsWith("estimate:")));

  const noCycle = itemToLinearPayload(
    { id: "pm-2", title: "y", tags: ["estimate:5", "cycle:Q3"] },
    parseFieldMap("cycle=ignore")
  );
  assert.equal(noCycle.cycleName, undefined, "cycle suppressed by --map");
  assert.equal(noCycle.estimate, 5, "estimate still present");
  assert.ok(!noCycle.labels?.some((t) => t.startsWith("cycle:")));
});

test("resolveCycleId resolves by name (case-insensitive), undefined when unknown", () => {
  const byName = { q3: "cyc-1", "42": "cyc-42" };
  assert.equal(resolveCycleId("Q3", byName), "cyc-1");
  assert.equal(resolveCycleId("q3", byName), "cyc-1");
  assert.equal(resolveCycleId("42", byName), "cyc-42", "numbered cycle resolves");
  assert.equal(resolveCycleId("nope", byName), undefined);
  assert.equal(resolveCycleId(undefined, byName), undefined);
});

// ---------------------------------------------------------------------------
// --cycle filter: server-side GraphQL clause + request plan wiring
// ---------------------------------------------------------------------------

test("buildIssuesQuery filters by cycle server-side when requested", () => {
  const q = buildIssuesQuery({ cycle: true });
  // The cycle constraint lives in the GraphQL filter (server-side), mirroring
  // --state, so --limit bounds the MATCHING issues rather than the pre-filter
  // page (large teams whose matching issues page beyond the fetched window).
  assert.ok(q.includes("cycle: { name: { containsIgnoreCase: $cycle } }"));
  assert.ok(q.includes("$cycle: String!"));
  const base = buildIssuesQuery({});
  assert.ok(!base.includes("$cycle"), "no cycle var when not requested");
  assert.ok(!base.includes("cycle: { name:"), "no cycle clause when not requested");
});

test("buildIssuesQuery composes --state and --cycle together", () => {
  const q = buildIssuesQuery({ state: true, cycle: true });
  assert.ok(q.includes("state: { name: { containsIgnoreCase: $state } }"));
  assert.ok(q.includes("cycle: { name: { containsIgnoreCase: $cycle } }"));
  assert.ok(q.includes("$state: String!"));
  assert.ok(q.includes("$cycle: String!"));
});

test("buildImportRequestPlan wires --cycle into the server-side filter", () => {
  const plan = buildImportRequestPlan("ENG", 100, { cycle: "Sprint 7" });
  assert.equal(plan.variables.cycle, "Sprint 7");
  assert.ok(plan.query.includes("cycle: { name: { containsIgnoreCase: $cycle } }"));
  assert.ok(plan.query.includes("$cycle: String!"));

  // whitespace-only / absent cycle adds nothing
  const blank = buildImportRequestPlan("ENG", 100, { cycle: "   " });
  assert.ok(!("cycle" in blank.variables), "blank cycle is not a filter");
  assert.ok(!blank.query.includes("$cycle"), "blank cycle adds no clause");

  const absent = buildImportRequestPlan("ENG", 100, {});
  assert.ok(!("cycle" in absent.variables), "absent cycle adds no var");
  assert.ok(!absent.query.includes("$cycle"), "absent cycle adds no clause");
});

test("normalizeCycleFilter trims surrounding whitespace and drops blank values", () => {
  assert.equal(normalizeCycleFilter("  Sprint 7  "), "Sprint 7");
  assert.equal(normalizeCycleFilter("   "), undefined);
  assert.equal(normalizeCycleFilter(undefined), undefined);
});

test("buildImportRequestPlan composes --state + --cycle + --project", () => {
  const plan = buildImportRequestPlan("ENG", 50, {
    project: "Q3",
    state: "In Progress",
    cycle: "Sprint 7",
  });
  assert.equal(plan.variables.project, "Q3");
  assert.equal(plan.variables.state, "In Progress");
  assert.equal(plan.variables.cycle, "Sprint 7");
  assert.ok(plan.query.includes("project: { name: { eq: $project } }"));
  assert.ok(plan.query.includes("state: { name: { containsIgnoreCase: $state } }"));
  assert.ok(plan.query.includes("cycle: { name: { containsIgnoreCase: $cycle } }"));
});

// ---------------------------------------------------------------------------
// Auth-failure error type (HTTP 401/403) — non-retriable, typed for clear msgs
// ---------------------------------------------------------------------------

test("AuthHttpError carries its HTTP status and is non-retriable by name", () => {
  const e401 = new AuthHttpError(401);
  assert.equal(e401.status, 401);
  assert.equal(e401.name, "AuthHttpError");
  assert.ok(e401.message.includes("401"), "message names the status");
  // Distinct from RetriableHttpError so the retry wrapper never retries auth.
  assert.notEqual(e401.name, "RetriableHttpError");

  const e403 = new AuthHttpError(403);
  assert.equal(e403.status, 403);
  assert.ok(e403.message.includes("403"));
});
