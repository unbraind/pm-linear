import assert from "node:assert/strict";
import test from "node:test";

import extension, {
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
} from "../dist/index.js";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers expected capabilities", () => {
  const registered: string[] = [];
  // Mirror the full ExtensionApi the activate() body actually touches; a partial
  // mock would throw TypeError when the extension calls an absent method.
  const api = {
    registerCommand: () => { registered.push("command"); },
    registerParser: () => { registered.push("parser"); },
    registerPreflight: () => { registered.push("preflight"); },
    registerService: () => { registered.push("service"); },
    registerFlags: () => { registered.push("flags"); },
    registerItemFields: () => { registered.push("itemFields"); },
    registerItemTypes: () => { registered.push("itemTypes"); },
    registerMigration: () => { registered.push("migration"); },
    registerRenderer: () => { registered.push("renderer"); },
    registerImporter: () => { registered.push("importer"); },
    registerExporter: () => { registered.push("exporter"); },
    registerSearchProvider: () => { registered.push("search"); },
    registerVectorStoreAdapter: () => { registered.push("vector"); },
    hooks: {
      beforeCommand: () => { registered.push("beforeCommand"); },
      afterCommand: () => { registered.push("afterCommand"); },
      onWrite: () => { registered.push("onWrite"); },
      onRead: () => { registered.push("onRead"); },
      onIndex: () => { registered.push("onIndex"); },
    },
  };
  extension.activate(api as any);
  // sync command, schema fields, the new linear importer/exporter, legacy importer
  assert.ok(registered.includes("command"), "should register the sync command");
  assert.ok(registered.includes("itemFields"), "should register item fields");
  assert.ok(registered.includes("importer"), "should register importer(s)");
  assert.ok(registered.includes("exporter"), "should register the exporter");
  assert.ok(registered.includes("preflight"), "should register the preflight guard");
  assert.ok(registered.includes("flags"), "should register importer/exporter flags");
});

test("parseStatusMap parses pairs case-insensitively and ignores junk", () => {
  assert.deepEqual(parseStatusMap(undefined), {});
  assert.deepEqual(parseStatusMap(""), {});
  assert.deepEqual(
    parseStatusMap("In Review=in_progress,Backlog=open"),
    { "in review": "in_progress", backlog: "open" }
  );
  // missing "=" segments are skipped
  assert.deepEqual(parseStatusMap("garbage,Done=closed"), { done: "closed" });
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
  const inverted = invertStatusMap(parseStatusMap("Backlog=open,In Review=in_progress"));
  assert.equal(inverted["open"], "backlog");
  assert.equal(resolveLinearStateName("open", inverted), "backlog");
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
});

const SAMPLE_ISSUE = {
  id: "lin-1",
  identifier: "ENG-1",
  title: "Fix login",
  description: "details",
  priority: 1,
  state: { name: "In Progress", type: "started" },
  labels: { nodes: [{ name: "bug" }, { name: "p0" }] },
  dueDate: "2026-07-01",
  cycle: null,
  url: "https://linear.app/x/issue/ENG-1",
};

test("buildItemPlan maps a Linear issue to resolved pm fields", () => {
  const plan = buildItemPlan(SAMPLE_ISSUE as any, {});
  assert.equal(plan.title, "[ENG-1] Fix login");
  assert.equal(plan.body, "details");
  assert.equal(plan.status, "in_progress");
  assert.equal(plan.priority, 1);
  assert.deepEqual(plan.tags, ["bug", "p0"]);
  assert.equal(plan.deadline, "2026-07-01");
  assert.ok(plan.description.includes("linear_id=lin-1"));
});

test("buildItemPlan honors --map field suppression and status-map", () => {
  const fieldMap = parseFieldMap("identifier=ignore,priority=ignore,labels=ignore");
  const plan = buildItemPlan(SAMPLE_ISSUE as any, {}, fieldMap);
  assert.equal(plan.title, "Fix login", "identifier prefix dropped");
  assert.equal(plan.priority, 3, "priority suppressed -> default medium");
  assert.deepEqual(plan.tags, [], "labels suppressed");
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

test("maskApiKey never leaks the full key", () => {
  assert.equal(maskApiKey(undefined), "");
  assert.equal(maskApiKey(""), "");
  const masked = maskApiKey("lin_api_supersecretvalue");
  assert.ok(masked.startsWith("lin_"));
  assert.ok(!masked.includes("supersecret"), "must not contain the secret tail");
  assert.ok(masked.includes("chars"));
});
