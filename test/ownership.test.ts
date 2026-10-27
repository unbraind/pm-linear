/** Ownership previews use real SDK trackers, an observable wire, and no git executable. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalDocument, parseTags, normalizeItemId, locateItem, PmClient, readLocatedItem, readSettings, type ItemMetadata } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildItemPlan, itemToLinearPayload, LINEAR_OWNERSHIP_FIELDS, LinearOwnershipRefusal, parseStatusMap, previewLinearOwnership, syncLinearIssues, buildAtomicImportMutations, negotiateLinearSchema, captureLinearThread, fetchLinearDependencyClosure, invertStatusMap, resolveLinearStateName, resolveCycleId, resolveLabelIds, parseProjectMap, resolveProjectTag, parseFieldMap, resolvePmField, indexItemsByLinearId, type LinearIssue, type LinearOwnershipOptions, type LinearOwnershipSnapshot } from "../index.ts";

/** Provider issue with every native mapped field, including null clearing coordinates. */
function issue(): LinearIssue & { updatedAt: string } {
  return { id: "remote", identifier: "ENG-1", title: "Context", description: " Body\r\ntext ", priority: 2,
    state: { name: "Queue", type: "unstarted" }, labels: { nodes: [{ name: "bug" }], pageInfo: { hasNextPage: false } } as LinearIssue["labels"],
    dueDate: "2026-12-01", cycle: { name: "Sprint" }, estimate: 3.5,
    customer: { name: "Synthetic" }, assignee: { name: "Agent", email: "agent@example.invalid" }, project: { name: "Project" },
    url: "https://linear.app/issue/ENG-1", updatedAt: "2026-10-27T00:00:00Z" };
}

/** Durable source bytes include configuration, schemas, relationships and histories. */
async function durable(root: string) {
  const entries = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile() && !entry.name.endsWith(".lock") && !entry.parentPath.includes("/cache"));
  return Promise.all(entries.sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name))).map(async (entry) => [join(entry.parentPath.slice(root.length), entry.name), await readFile(join(entry.parentPath, entry.name), "utf8")]));
}

/** Isolated read-only acquisition with observable request interleavings. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "linear-ownership-"));
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" });
  await pm.init("ownership");
  const state = { rawIssuesBody: undefined as string | undefined, rawBody: undefined as string | undefined, issue: issue() as unknown, errors: undefined as unknown, status: 200, requests: [] as string[], onRead: undefined as (() => Promise<void>) | undefined };
  const plan = buildItemPlan(state.issue as LinearIssue, {});
  const created = await pm.create({ ...plan, id: "selected", type: "Task", tags: plan.tags.join(","), parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive" });
  const id = created.item.id;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => { void (async () => {
      const request = JSON.parse(body) as { query: string };
      state.requests.push(request.query);
      await state.onRead?.();
      res.writeHead(state.status, { "Content-Type": "application/json", Connection: "close" });
      const provider = state.issue as ReturnType<typeof issue>;
      const pageInfo = { hasNextPage: false, endCursor: null };
      const data = request.query.includes("LinearSchema") ? {
        teams: { nodes: [{ id: "team", key: "ENG", cyclesEnabled: false, triageEnabled: false,
          issueEstimationType: "notUsed", defaultIssueState: null,
          states: { nodes: [{ id: "state", ...provider.state }], pageInfo } }] },
        issueLabels: { nodes: provider.labels.nodes.map((label, index) => ({ id: `label-${index}`, name: label.name })), pageInfo },
      } : request.query.includes("issues(") ? { issues: { nodes: [state.issue], pageInfo } } : { issue: state.issue };
      res.end((request.query.includes("issues(") ? state.rawIssuesBody : undefined) ?? state.rawBody ?? JSON.stringify({ data, errors: state.errors }));
    })(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const changes = { LINEAR_API_KEY: "synthetic-key", LINEAR_API_BASE_URL: `http://127.0.0.1:${addr.port}/graphql`, GIT_CEILING_DIRECTORIES: tmpdir(), PATH: root };
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, pm, id, state, options: { item: id } satisfies LinearOwnershipOptions };
}

/** Assert a typed sanitized refusal with a concrete recovery instruction. */
function refused(code: LinearOwnershipRefusal["code"]) {
  return (error: unknown) => { assert.ok(error instanceof LinearOwnershipRefusal); assert.equal(error.code, code); assert.equal(error.exitCode, 2); assert.ok(error.remedy.length > 20); assert.doesNotMatch(error.message, /synthetic-key/); return true; };
}

test("known bases distinguish disjoint edits and same-field conflicts; absent bases never authorize overwrite", async (t) => {
  const { root, pm, state, options } = await fixture(t);
  const before = await durable(root);
  const first = await previewLinearOwnership(options, root);
  assert.equal(first.counts.unknown, 8);
  assert.equal(first.atomicCrossSystem, false);
  assert.match(first.guarantee, /no atomic cross-system guarantees/);
  assert.ok(JSON.stringify(first).length < 4096);
  assert.deepEqual(await durable(root), before);
  const base = first.observation;
  const unchanged = await previewLinearOwnership({ ...options, base }, root);
  assert.ok(unchanged.fields.every((field) => field.decision === "unchanged"), JSON.stringify(unchanged.fields));
  await pm.update(options.item, { title: "Local title" });
  (state.issue as LinearIssue).priority = 1;
  const disjoint = await previewLinearOwnership({ ...options, base }, root);
  assert.equal(disjoint.disjoint, true);
  assert.equal(disjoint.fields.find((row) => row.field === "title")?.decision, "local_edit");
  assert.equal(disjoint.fields.find((row) => row.field === "priority")?.decision, "provider_edit");
  (state.issue as LinearIssue).title = "Provider title";
  assert.equal((await previewLinearOwnership({ ...options, base }, root)).counts.conflicts, 1);
  await pm.update(options.item, { title: "[ENG-1] Provider title" });
  assert.equal((await previewLinearOwnership({ ...options, base }, root)).fields[0].decision, "aligned");
  const foreign = { ...base, linearId: "foreign" };
  assert.equal((await previewLinearOwnership({ ...options, base: foreign }, root)).counts.unknown, 8);
  const invalid = structuredClone(base);
  invalid.fields[0].local = "invalid";
  const partial = await previewLinearOwnership({ ...options, base: invalid }, root);
  assert.equal(partial.counts.unknown, 1);
  const duplicate = structuredClone(base); duplicate.fields[1] = duplicate.fields[0];
  assert.equal((await previewLinearOwnership({ ...options, base: duplicate }, root)).counts.unknown, 2);
  assert.ok(state.requests.every((query) => !query.includes("mutation")));
});

test("CLI agrees with SDK in JSON and native TOON dispatch, including baseline files and typed input errors", async (t) => {
  const { root, options } = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  const sdk = await previewLinearOwnership(options, root);
  for (const global of [{ json: true }, {}]) {
    const result = await harness.runCommand({ command: "linear ownership", pmRoot: root, options, global });
    assert.deepEqual(result.result, sdk);
  }
  const file = join(root, "base.json");
  await writeFile(file, JSON.stringify(sdk.observation));
  const output = await harness.runCommand({ command: "linear ownership", pmRoot: root, options: { ...options, base: file, statusMap: "Queue=open", maxOutputBytes: "8192" }, global: { json: true } });
  assert.equal((output.result as { base: string }).base, "foreign");
  for (const value of ["broken", " ".repeat(17000)]) {
    await writeFile(file, value);
    const refusal = await harness.runCommand({ command: "linear ownership", pmRoot: root, options: { ...options, base: file }, global: {} });
    assert.equal(refusal.exitCode, 2);
    assert.equal(refusal.errorCode, "invalid_input");
    assert.equal((refusal.result as { code: string }).code, "invalid_input");
    assert.ok(refusal.remediation);
  }
  const invalid = await harness.runCommand({ command: "linear ownership", pmRoot: root, options: {}, global: {} });
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.errorCode, "invalid_input");
});

test("strict dense schemas reject extreme inputs before side effects; old content is allowed", async (t) => {
  const { root, state, options } = await fixture(t);
  const before = await durable(root);
  for (const maxOutputBytes of [NaN, Infinity, -Infinity, -1, 0, 2047, 65537, Number.MAX_VALUE, 2048.5]) {
    await assert.rejects(previewLinearOwnership({ ...options, maxOutputBytes }, root), refused("invalid_input"));
  }
  for (const extra of [{ unknown: true }, { base: null }, { statusMap: [] }, { statusMap: { Queue: 42 } }, { statusMap: { Queue: "" } }, { statusMap: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`state-${index}`, "open"])) }, { base: { fields: new Array(8) } }]) {
    await assert.rejects(previewLinearOwnership({ ...options, ...extra } as LinearOwnershipOptions, root), refused("invalid_input"));
  }
  assert.equal(state.requests.length, 0);
  const native = issue();
  for (const patch of [{ priority: Infinity }, { priority: 0.5 }, { estimate: -1 }, { estimate: 1000001 }, { labels: { nodes: new Array(1), pageInfo: { hasNextPage: false } } }, { labels: { nodes: [], pageInfo: { hasNextPage: true } } }, { state: { name: "Unknown", type: 42 } }, { title: "x".repeat(32769) }, { id: "other" }, { extra: true }]) {
    state.issue = { ...native, ...patch };
    await assert.rejects(previewLinearOwnership(options, root), refused("source_invalid"));
  }
  state.issue = { ...native, title: " Legacy /archived/context ", description: "\r\nUnicode Ω and trailing whitespace  ", estimate: 0.125 };
  assert.equal((await previewLinearOwnership(options, root)).ok, true);
  await assert.rejects(previewLinearOwnership({ ...options, maxOutputBytes: 2048 }, root), refused("output_budget"));
  assert.deepEqual(await durable(root), before);
});

test("access refusals, ambiguous links and concurrent observations fail safely", async (t) => {
  const { root, pm, state, options } = await fixture(t);
  delete process.env.LINEAR_API_KEY;
  await assert.rejects(previewLinearOwnership(options, root), refused("access_denied"));
  process.env.LINEAR_API_KEY = "synthetic-key";
  state.status = 401;
  await assert.rejects(previewLinearOwnership(options, root), refused("access_denied"));
  state.status = 200; state.errors = [{ message: "synthetic-key" }];
  await assert.rejects(previewLinearOwnership(options, root), refused("access_denied"));
  state.errors = undefined;
  await assert.rejects(previewLinearOwnership({ item: "missing" }, root), refused("selection_required"));
  for (const boundary of [1, 2]) {
    let reads = 0;
    state.onRead = async () => { if (++reads === boundary) await pm.update(options.item, { title: `Peer success ${boundary}` }); };
    await assert.rejects(previewLinearOwnership(options, root), refused("source_changed"));
    const peer = await pm.get(options.item);
    assert.equal(peer.item.title, `Peer success ${boundary}`);
  }
  state.onRead = undefined;
  let reads = 0;
  state.onRead = async () => { if (++reads === 2) (state.issue as LinearIssue).title = "Peer provider success"; };
  await assert.rejects(previewLinearOwnership(options, root), refused("source_changed"));
  state.onRead = undefined;
  await pm.create({ title: "Duplicate", description: buildItemPlan(issue(), {}).description, parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive" });
  await assert.rejects(previewLinearOwnership(options, root), refused("selection_required"));
  await assert.rejects(previewLinearOwnership(options, join(root, "missing")), refused("local_read_failed"));
});

/** Reference field hashes come only from the SDK's persistence canonicalizer. */
async function stateFromSdk(root: string, id: string) {
  const located = await locateItem(root, id); assert.ok(located);
  return (await readLocatedItem(located, { schema: (await readSettings(root)).schema })).document;
}

/** Digest the canonical SDK document without handwritten whitespace or metadata normalization. */
function hashes(document: Awaited<ReturnType<typeof stateFromSdk>>) {
  const metadata = document.metadata as unknown as Record<string, unknown>;
  return new Map(LINEAR_OWNERSHIP_FIELDS.map((field) => [field, createHash("sha256").update(JSON.stringify(field === "body" ? document.body : field === "deadline" ? itemToLinearPayload({ deadline: document.metadata.deadline }).dueDate ?? null : metadata[field] ?? null)).digest("hex")]));
}

test("500 seeded operation sequences cover historical replays, CRLF, all fields, relationships and random status roles", async (t) => {
  const { root, pm, state, options } = await fixture(t);
  await pm.create({ id: "foreign", title: "Foreign", parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive" });
  await pm.update(options.item, { parent: "foreign", dep: ["id=foreign,kind=blocked_by"], goal: "foreign", objective: "foreign", sprint: "one", release: "two" });
  let seed = 0x10272026;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const history: LinearOwnershipSnapshot[] = [];
  const providers: ReturnType<typeof issue>[] = [];
  const changes = ["title", "body", "priority", "tags", "deadline", "assignee", "status", "description"] as const;
  let baseline = (await previewLinearOwnership(options, root)).observation;
  for (let sequence = 0; sequence < 500; sequence++) {
    if (sequence % 100 === 0) t.diagnostic(`seed 0x10272026: sequence ${sequence}/500`);
    if (sequence % 50 === 0) await pm.focus(random() < 0.5 ? "foreign" : options.item);
    history.push(JSON.parse(JSON.stringify(baseline)) as LinearOwnershipSnapshot); providers.push(structuredClone(state.issue as ReturnType<typeof issue>));
    const choice = changes[Math.floor(random() * changes.length)];
    if (sequence % 25 === 0) {
      const status = `custom_${sequence}`;
      const role = ["active", "blocked", "draft", "terminal_done", "terminal_canceled"][Math.floor(random() * 5)];
      await pm.schemaAddStatus(status, { role: [role] });
      await pm.update(options.item, { status, closeReason: "Synthetic lifecycle" });
    }
    const writes = {
      title: { title: ` Local ${sequence} Ω ` }, body: { body: ` Body ${sequence}\r\ntext  ` },
      priority: { priority: Math.floor(random() * 5) }, tags: { tags: `bug,estimate:${sequence / 2},cycle: Week ${sequence},customer: Synthetic` },
      deadline: { deadline: sequence % 2 ? "2026-12-01" : "2026-12-02" }, assignee: { assignee: `agent-${sequence}` },
      status: { status: sequence % 2 ? "open" : "in_progress" }, description: { description: buildItemPlan(issue(), {}).description },
    };
    await pm.update(options.item, writes[choice]);
    if (random() < 0.4) state.issue = structuredClone(providers[Math.floor(random() * providers.length)]);
    else { const next = issue();
      const names = ["Blocked", "In Review", "Done", "Canceled", "Queue", "__proto__", "constructor"];
      const types = ["unstarted", "started", "completed", "canceled", "backlog", "triage"];
      next.state = { name: names[Math.floor(random() * names.length)], type: types[Math.floor(random() * types.length)] };
      next.priority = Math.floor(random() * 5);
      const labels = ["none", "a,b", "-", " Bug ", "Ω label"];
      next.labels = { nodes: [{ name: labels[Math.floor(random() * labels.length)] }], pageInfo: { hasNextPage: false } } as LinearIssue["labels"];
      next.cycle = sequence % 3 === 0 ? { name: null } : sequence % 3 === 1 ? undefined : { name: ` Week ${sequence} ` };
      next.estimate = sequence % 4 === 0 ? null : sequence / 2;
      next.title = `Provider ${sequence}`; next.description = sequence % 2 ? "\r\n Body " : "Body "; next.dueDate = sequence % 2 ? null : "2026-12-01"; next.assignee = sequence % 2 ? null : { name: "Peer", email: null }; state.issue = next; }
    const base = random() < 0.4 ? history[Math.floor(random() * history.length)] : baseline;
    const before = await stateFromSdk(root, options.item);
    const local = hashes(before);
    const settings = await readSettings(root);
    // The oracle reads the exact plan produced by real atomic dry-run import,
    // including real provider schema negotiation and complete SDK local reads.
    const imported = await syncLinearIssues({ team: "ENG", limit: 1, atomic: true, dryRun: true }, root);
    assert.equal(imported.prepared?.length, 1);
    const plan = imported.prepared![0];
    assert.ok(Object.keys(plan).every((key) => ["identifier", "linearId", "match"].includes(key) || LINEAR_OWNERSHIP_FIELDS.some((field) => field === key)), "every native field emitted by import must be represented in the preview schema");
    const mapped = Object.fromEntries(LINEAR_OWNERSHIP_FIELDS.filter((key) => key !== "body" && Object.hasOwn(plan, key))
      .map((key) => [key, (plan as unknown as Record<string, unknown>)[key]]));
    const remote = hashes(canonicalDocument({ metadata: { ...before.metadata, ...mapped } as ItemMetadata, body: plan.body }, { schema: settings.schema }));
    const report = await previewLinearOwnership({ ...options, base }, root);
    baseline = report.observation;
    for (const field of report.fields) {
      const previous = base.fields.find((row) => row.field === field.field)!;
      const left = local.get(field.field), right = remote.get(field.field);
      const expected = report.base === "foreign" || previous.local !== previous.provider ? "unknown_base" :
        left === right ? left === previous.local ? "unchanged" : "aligned" :
        left === previous.local ? "provider_edit" : right === previous.provider ? "local_edit" : "conflict";
      assert.equal(field.decision, expected, `seed sequence ${sequence}, ${field.field}`);
    }
    assert.deepEqual(await stateFromSdk(root, options.item), before);
    assert.ok(Object.values(report.counts).every((count) => Number.isFinite(count) && count >= 0 && count <= 8));
    assert.deepEqual(report.observation.fields.map((row) => row.local), LINEAR_OWNERSHIP_FIELDS.map((field) => local.get(field)));
    const exported = itemToLinearPayload({ ...before.metadata, body: before.body });
    assert.equal(exported.linearId, "remote");
    assert.equal(exported.description, before.body);
  }
});

test("custom status aliases and provider names use the same importer mapping and SDK normalization", async (t) => {
  const { root, pm, state, options } = await fixture(t);
  await pm.schemaAddStatus("reviewing", { role: ["active"], alias: ["ongoing"] });
  await pm.update(options.item, { status: "reviewing" });
  (state.issue as LinearIssue).state = { name: "Done", type: "started" };
  const observed = await previewLinearOwnership({ ...options, statusMap: { Queued: "open", " Done ": "ongoing" } }, root);
  assert.equal(observed.observation.fields.find((field) => field.field === "status")?.local, observed.observation.fields.find((field) => field.field === "status")?.provider);
  const replay = await previewLinearOwnership({ ...options, base: JSON.parse(JSON.stringify(observed.observation)) as LinearOwnershipSnapshot, statusMap: { done: "reviewing", queued: "open" } }, root);
  assert.equal(replay.base, "acknowledged");
  assert.equal(replay.fields.find((field) => field.field === "status")?.decision, "unchanged");
  await assert.rejects(previewLinearOwnership({ ...options, statusMap: { Done: "missing-status" } }, root), refused("invalid_input"));
  await assert.rejects(previewLinearOwnership({ ...options, statusMap: { Done: "open", done: "reviewing" } }, root), refused("invalid_input"));
  (state.issue as LinearIssue).state = { name: "__proto__", type: "started" };
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  const proto = await harness.runCommand({ command: "linear ownership", pmRoot: root, options: { ...options, statusMap: "__proto__=ongoing" }, global: { json: true } });
  assert.deepEqual(proto.result, await previewLinearOwnership({ ...options, statusMap: Object.fromEntries([["__proto__", "reviewing"]]) }, root));
  (state.issue as LinearIssue).state = { name: "Done", type: "unstarted" };
  await pm.update(options.item, { status: buildItemPlan(state.issue as LinearIssue, {}).status, closeReason: "Shared import mapping" });
  const plain = await previewLinearOwnership(options, root);
  assert.equal(plain.observation.fields.find((field) => field.field === "status")?.local, plain.observation.fields.find((field) => field.field === "status")?.provider);
});

test("source isolation precedes SDK scaffolding even for immutable trackers and absent schema history", async (t) => {
  const { root, options } = await fixture(t);
  for (const absent of ["history", "schema"]) {
    await rm(join(root, absent), { recursive: true, force: true });
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o555 : 0o444);
    await chmod(root, 0o555);
    try {
      const before = await durable(root);
      assert.equal((await previewLinearOwnership(options, root)).ok, true);
      assert.deepEqual(await durable(root), before);
    } finally {
      await chmod(root, 0o700);
      for (const entry of entries) await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600);
    }
  }
});


test("installed host SDK links are excluded from isolated data reads without following foreign item links", async (t) => {
  const { root, options } = await fixture(t);
  const runtime = join(root, "extensions/pm-linear/node_modules/@unbrained");
  await mkdir(runtime, { recursive: true });
  await symlink(join(root, "settings.json"), join(runtime, "pm-cli"));
  assert.equal((await previewLinearOwnership(options, root)).ok, true);
  await symlink(join(root, "settings.json"), join(root, "tasks/foreign.toon"));
  await assert.rejects(previewLinearOwnership(options, root), refused("local_read_failed"));
});


test("prototype-shaped status-map keys are own data", () => {
  const map = parseStatusMap("__proto__=open,constructor=blocked,toString=in_progress");
  for (const key of ["__proto__", "constructor", "toString"]) assert.equal(Object.hasOwn(map, key), true);
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
});


test("review class: preview verdicts match the real import status mapping", async (t) => {
  const { root, pm, state, options } = await fixture(t);
  const base = (await previewLinearOwnership(options, root)).observation;
  await pm.update(options.item, { status: "in_progress" });
  (state.issue as LinearIssue).state = { name: "Blocked", type: "unstarted" };
  const report = await previewLinearOwnership({ ...options, base }, root);
  assert.equal(report.fields.find((field) => field.field === "status")?.decision, "conflict");
  const dry = await syncLinearIssues({ team: "ENG", limit: 1, atomic: true, dryRun: true }, root);
  assert.equal(dry.prepared?.[0].status, "blocked");
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  const file = join(root, "acknowledged.json"); await writeFile(file, JSON.stringify(base));
  for (const global of [{ json: true }, {}]) {
    const cli = await harness.runCommand({ command: "linear ownership", pmRoot: root, options: { ...options, base: file }, global });
    assert.deepEqual(cli.result, report);
  }
});

test("review class: nullable and omitted provider objects round-trip through import and ownership", async (t) => {
  const { root, state, options } = await fixture(t);
  const native = issue();
  for (const type of ["duplicate", "cancelled", "mystery"]) {
    state.issue = { ...native, state: { name: "Canceled", type } };
    const report = await previewLinearOwnership(options, root);
    const dry = await syncLinearIssues({ team: "ENG", limit: 1, atomic: true, dryRun: true }, root);
    assert.equal(dry.prepared?.[0].status, "closed");
    assert.equal(report.ok, true);
  }
  for (const cycle of [undefined, null, { name: null }, { name: "" }, { name: " Sprint Ω " }]) {
    state.issue = { ...native, cycle, assignee: undefined, project: undefined, customer: undefined };
    const report = await previewLinearOwnership(options, root);
    const dry = await syncLinearIssues({ team: "ENG", limit: 1, atomic: true, dryRun: true }, root);
    assert.equal(dry.prepared?.length, 1);
    assert.equal(report.ok, true);
    assert.deepEqual(dry.prepared?.[0].tags, buildItemPlan(state.issue as LinearIssue, {}).tags);
  }
  for (const [field, patch] of [
    ["issue.cycle.name", { cycle: { name: 42 } }],
    ["issue.assignee.name", { assignee: { name: 42, email: null } }],
    ["issue.project.name", { project: { name: false } }],
    ["issue.labels.nodes[0].name", { labels: { nodes: [{ name: null }], pageInfo: { hasNextPage: false } } }],
  ] as const) {
    state.issue = { ...native, ...patch };
    await assert.rejects(previewLinearOwnership(options, root), (error: unknown) => {
      assert.ok(error instanceof LinearOwnershipRefusal); assert.equal(error.code, "source_invalid");
      assert.equal(error.field, field); assert.ok(error.remedy.includes(field)); return true;
    });
  }
});

test("review class: every malformed duplicate poisons its field in either row order", async (t) => {
  const { root, options } = await fixture(t);
  const observation = (await previewLinearOwnership(options, root)).observation;
  for (const field of LINEAR_OWNERSHIP_FIELDS) {
    const original = observation.fields.find((row) => row.field === field)!;
    for (const bad of [{ ...original, local: "invalid" }, { ...original, provider: null }, { field, extra: true }]) {
      for (const reverse of [false, true]) {
        const rows = reverse ? [bad, original] : [original, bad];
        const base = { ...observation, fields: rows } as LinearOwnershipSnapshot;
        const report = await previewLinearOwnership({ ...options, base }, root);
        assert.equal(report.fields.find((row) => row.field === field)?.decision, "unknown_base", `${field}/${reverse}`);
      }
    }
  }
  for (const row of [null, 1, { field: "Title" }, { field: "constructor" }]) {
    const base = { ...observation, fields: [observation.fields[0], row] } as LinearOwnershipSnapshot;
    assert.equal((await previewLinearOwnership({ ...options, base }, root)).counts.unknown, 8);
  }
});

test("review class: malformed envelopes always become typed field refusals in SDK and CLI", async (t) => {
  const { root, state, options } = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  state.rawBody = "synthetic malformed response";
  await assert.rejects(previewLinearOwnership(options, root), refused("source_invalid"));
  for (const value of [null, [], 1, true, "body", {}, { extensions: {} }, { data: 1 }, { data: [] }, { errors: {} }, { errors: [null] }, { errors: [{ message: 1 }] }]) {
    state.rawBody = JSON.stringify(value);
    await assert.rejects(previewLinearOwnership(options, root), (error: unknown) => {
      assert.ok(error instanceof LinearOwnershipRefusal); assert.equal(error.code, "source_invalid");
      assert.match(error.field ?? "", /^response/); return true;
    });
    for (const global of [{ json: true }, {}]) {
      const cli = await harness.runCommand({ command: "linear ownership", pmRoot: root, options, global });
      assert.equal(cli.exitCode, 2); assert.equal(cli.errorCode, "source_invalid");
      assert.match((cli.result as { field: string }).field, /^response/);
    }
  }
});


test("review class: every source consumer rejects non-object envelopes before dereference", async (t) => {
  const { root, state, options } = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  for (const value of [null, [], 1]) {
    state.rawBody = JSON.stringify(value);
    for (const action of [
      () => negotiateLinearSchema({ team: "ENG" }, root),
      () => captureLinearThread({ itemId: options.item, threadId: "root" }, root),
      () => fetchLinearDependencyClosure({ items: [options.item] }, root),
      () => syncLinearIssues({ team: "ENG", limit: 1, atomic: true, dryRun: true }, root),
    ]) {
      await assert.rejects(action(), (error: unknown) => {
        assert.ok(error instanceof Error && !(error instanceof TypeError));
        assert.equal((error as { code?: string }).code, "source_invalid");
        assert.match(error.message, /response/); return true;
      });
    }
    for (const global of [{ json: true }, {}]) {
      for (const [command, commandOptions] of [
        ["linear schema", { team: "ENG" }], ["linear capture", { item: options.item, thread: "root" }],
        ["linear closure", { items: options.item }], ["linear sync", { team: "ENG", atomic: true, dryRun: true }],
      ] as const) {
        const result = await harness.runCommand({ command, pmRoot: root, options: commandOptions, global });
        assert.equal(result.exitCode, 2, command); assert.equal(result.errorCode, "source_invalid", command);
        assert.match((result.result as { field: string }).field, /^response/, command);
      }
      for (const importer of ["linear", "linear-sync"]) {
        const result = await harness.runImporter({ importer, pmRoot: root, options: { team: "ENG", atomic: true, dryRun: true }, global });
        assert.equal(result.exitCode, 2, importer); assert.equal(result.errorCode, "source_invalid", importer);
        assert.equal((result.result as { field: string }).field, "response");
      }
      const exported = await harness.runExporter({ exporter: "linear", pmRoot: root, options: { push: true, team: "ENG" }, global });
      assert.equal(exported.exitCode, 2); assert.equal(exported.errorCode, "source_invalid");
      assert.match((exported.result as { field: string }).field, /^response/);
    }
    const diagnostics = await harness.runCommand({ command: "linear validate", pmRoot: root, options: { checkNetwork: true }, global: { json: true } });
    assert.match((diagnostics.result as { networkError: string }).networkError, /source_invalid.*response/);
  }
});

test("review class: all mapping directions treat prototype-shaped names as data", () => {
  for (const name of ["__proto__", "constructor", "toString"]) {
    const lower = name.toLowerCase();
    const map = Object.fromEntries([[name, "target"]]);
    const inverted = invertStatusMap(map);
    assert.equal(resolveLinearStateName("target", inverted), name);
    const reverse = invertStatusMap(Object.fromEntries([["Native", name]]));
    assert.equal(Object.hasOwn(reverse, lower), true);
    assert.equal(resolveLinearStateName(name, reverse), "Native");
    assert.equal(resolveLinearStateName(name, {}), undefined);
    assert.equal(resolveCycleId(name, {}), undefined);
    assert.deepEqual(resolveLabelIds([name], {}), []);
    const native = Object.fromEntries([[lower, "id"]]);
    assert.equal(resolveCycleId(name, native), "id");
    assert.deepEqual(resolveLabelIds([name], native), ["id"]);
    assert.equal(resolveProjectTag(name, parseProjectMap(`${name}=tag`)), "tag");
    assert.equal(resolvePmField(parseFieldMap(`${name}=title`), name), "title");
    const indexed = indexItemsByLinearId([{ id: "local", description: `[linear] linear_id=${name}` }]);
    assert.equal(Object.hasOwn(indexed, name), true);
    assert.equal(indexed[name].id, "local");
  }
});


test("review class: ambiguous current identities never become import targets in either writer", async (t) => {
  const { root, pm, options } = await fixture(t);
  const description = buildItemPlan(issue(), {}).description;
  const items = [{ id: "one", description }, { id: "two", description }];
  assert.equal(Object.hasOwn(indexItemsByLinearId(items), "remote"), false);
  await pm.create({ id: "duplicate", title: "Foreign duplicate", description, parent: "none", unset: ["goal", "objective", "sprint", "release", "assignee"], createMode: "progressive" });
  const before = await stateFromSdk(root, options.item);
  const messages: string[] = [];
  const previous = console.error;
  try {
    console.error = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
    for (const atomic of [true, false]) {
      const result = await syncLinearIssues({ team: "ENG", limit: 1, atomic, dryRun: atomic }, root);
      assert.equal(result.created, 0); assert.equal(result.updated, 0); assert.equal(result.skipped, 1);
      if (atomic) assert.deepEqual(result.prepared, []);
    }
  } finally { console.error = previous; }
  assert.equal(messages.filter((message) => /Skipped ambiguous/.test(message)).length, 2);
  assert.ok(messages.every((message) => !/Failed to (create|update)/.test(message)));
  assert.deepEqual(await stateFromSdk(root, options.item), before);
});


test("review class: export and credential consumers validate every dereferenced container", async (t) => {
  const { root, state } = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  for (const teams of [{ nodes: "bad" }, { nodes: [1] }, { nodes: [{ id: "team", states: { nodes: {} } }] }, { nodes: [{ id: "team", labels: { nodes: [{ name: 1 }] } }] }, { nodes: [{ id: "team", cycles: { nodes: [{ name: null, number: "bad" }] } }] }]) {
    state.rawBody = JSON.stringify({ data: { teams } });
    const result = await harness.runExporter({ exporter: "linear", pmRoot: root, options: { push: true, team: "ENG" }, global: { json: true } });
    assert.equal(result.exitCode, 2); assert.equal(result.errorCode, "source_invalid");
    assert.match((result.result as { field: string }).field, /^team/);
  }
  for (const viewer of [undefined, null, {}]) {
    state.rawBody = JSON.stringify({ data: { viewer } });
    const result = await harness.runCommand({ command: "linear validate", pmRoot: root, options: { checkNetwork: true }, global: { json: true } });
    const diagnostics = result.result as { networkOk: boolean; networkError: string };
    assert.equal(diagnostics.networkOk, false);
    assert.match(diagnostics.networkError, /returned no viewer/);
  }
  for (const viewer of [1, [], { id: {} }]) {
    state.rawBody = JSON.stringify({ data: { viewer } });
    const result = await harness.runCommand({ command: "linear validate", pmRoot: root, options: { checkNetwork: true }, global: { json: true } });
    const diagnostics = result.result as { networkOk: boolean; networkError: string };
    assert.equal(diagnostics.networkOk, false);
    assert.match(diagnostics.networkError, /source_invalid.*viewer/);
  }
});


test("review class: preflight source refusals survive host dispatch without losing typed fields", async (t) => {
  const { root, state } = await fixture(t);
  state.rawBody = "null";
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  const pre = await harness.runPreflightOverride({
    command: "linear sync", args: [], options: { team: "ENG" }, global: { json: true }, pm_root: root,
    decision: { enforce_item_format_gate: false, run_preflight_item_format_sync: false, run_extension_migrations: false, enforce_mandatory_migration_gate: false },
  });
  const opts = (pre as { context?: { options?: Record<string, unknown> } }).context?.options ?? {};
  assert.equal(opts.__linear_preflight_source_field, "response");
  const result = await harness.runCommand({ command: "linear sync", pmRoot: root, options: { team: "ENG", ...opts }, global: { json: true } });
  assert.equal(result.exitCode, 2); assert.equal(result.errorCode, "source_invalid");
  assert.equal((result.result as { field: string }).field, "response");
});


test("review class: import validates every selected page container before planning", async (t) => {
  const { root, pm, state } = await fixture(t);
  const before = await pm.listAllComplete({ includeBody: true });
  for (const issues of [1, [], { nodes: {} }, { nodes: [null] }, { nodes: [], pageInfo: 1 }, { nodes: [], pageInfo: { hasNextPage: "yes" } }, { nodes: [], pageInfo: { endCursor: 42 } }]) {
    state.rawIssuesBody = JSON.stringify({ data: { issues } });
    await assert.rejects(syncLinearIssues({ team: "ENG", limit: 1, atomic: true, dryRun: true }, root), (error: unknown) => {
      assert.ok(error instanceof Error && !(error instanceof TypeError));
      assert.equal((error as { code?: string }).code, "source_invalid");
      assert.match((error as { field?: string }).field ?? "", /^issues/); return true;
    });
  }
  assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, before.items);
});


test("review class: legacy updates apply empty mapped values just like the shared dry-run plan", async (t) => {
  const { root, pm, state, options } = await fixture(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await symlink(join(import.meta.dirname, "../node_modules/.bin/pm"), join(bin, "pm"));
  process.env.PATH = bin;
  await pm.create({ id: "peer", title: "Peer", parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive" });
  await pm.focus("peer");
  const before = await stateFromSdk(root, options.item);
  const provider = state.issue as LinearIssue;
  provider.description = ""; provider.labels = { nodes: [] }; provider.cycle = null; provider.estimate = null; provider.customer = null;
  const dry = await syncLinearIssues({ team: "ENG", limit: 1, atomic: true, dryRun: true }, root);
  assert.equal(dry.prepared?.[0].body, ""); assert.deepEqual(dry.prepared?.[0].tags, []);
  const result = await syncLinearIssues({ team: "ENG", limit: 1 }, root);
  assert.equal(result.updated, 1); assert.equal(result.skipped, 0);
  const after = await stateFromSdk(root, options.item);
  assert.equal(after.body, ""); assert.deepEqual(after.metadata.tags ?? [], []);
  assert.equal(after.metadata.parent, before.metadata.parent);
  assert.ok(state.requests.every((query) => !query.includes("mutation")));
});

test("review class: malformed export acknowledgements are typed and never report a confirmed write", async (t) => {
  const { root, pm, state, options } = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  state.onRead = async () => {
    state.rawBody = state.requests.at(-1)?.includes("mutation") ? "null" : JSON.stringify({ data: { teams: { nodes: [{ id: "team" }] } } });
  };
  for (const action of ["issueUpdate", "issueCreate"]) {
    if (action === "issueCreate") await pm.update(options.item, { description: "" });
    for (const global of [{ json: true }, {}]) {
      const start = state.requests.length;
      const result = await harness.runExporter({ exporter: "linear", pmRoot: root, options: { team: "ENG", push: true }, global });
      assert.equal(result.exitCode, 2); assert.equal(result.errorCode, "source_invalid");
      const receipt = result.result as { field: string; write_unconfirmed: boolean; remedy: string };
      assert.equal(receipt.field, "response"); assert.equal(receipt.write_unconfirmed, true);
      assert.match(receipt.remedy, /write may already have succeeded/);
      assert.equal(state.requests.slice(start).filter((query) => query.includes(action)).length, 1);
    }
  }
});

test("review class: every import alias advertises the same complete apply-path flags", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  const current = harness.assertFlags({ targetCommand: "linear import" });
  const alias = harness.assertFlags({ targetCommand: "linear-sync import", flags: current.flags.map((flag) => { assert.ok(typeof flag.long === "string"); return flag.long; }) });
  assert.deepEqual(alias.flags, current.flags);
});

test("review class: every offline import alias counts linked terminal items and excludes unlinked items", async (t) => {
  const { root, pm, state } = await fixture(t);
  for (const [id, status, description] of [["terminal", "closed", "[linear] linear_id=terminal"], ["unlinked", "open", "Ordinary context"]]) {
    await pm.create({ id, title: id, status, description, closeReason: "Fixture completed", body: "", tags: "[]", parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive", allowDuplicate: true });
  }
  const before = (await pm.listAllComplete({ includeBody: true })).items;
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  for (const global of [{ json: true }, {}]) {
    for (const run of [
      () => harness.runCommand({ command: "linear sync", pmRoot: root, options: { team: "ENG", dryRun: true }, global }),
      ...["linear", "linear-sync"].map((importer) => () => harness.runImporter({ importer, pmRoot: root, options: { team: "ENG", dryRun: true }, global })),
    ]) {
      const result = await run();
      assert.equal((result.result as { existingLinkedItems: number }).existingLinkedItems, 2);
    }
  }
  assert.equal(state.requests.length, 0);
  assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, before);
});


test("review class: every tag producer preserves literal SDK control words and delimiters through real writers", async (t) => {
  const { root, pm, state, options } = await fixture(t);
  const savedAuthor = process.env.PM_AUTHOR;
  process.env.PM_AUTHOR = "fixture";
  t.after(() => { if (savedAuthor === undefined) delete process.env.PM_AUTHOR; else process.env.PM_AUTHOR = savedAuthor; });
  const bin = join(root, "bin"); await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await symlink(join(import.meta.dirname, "../node_modules/.bin/pm"), join(bin, "pm"));
  process.env.PATH = bin;
  const provider = state.issue as LinearIssue;
  provider.cycle = null; provider.estimate = null; provider.customer = null;
  const settings = await readSettings(root);
  let seed = 0x1abe12026;
  const reference = (await stateFromSdk(root, options.item)).metadata;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const vocabulary = ["none", "null", "-", "a,b", " BUG ", "Ω label", "quoted\"label", "CRLF\r\nlabel"];
  for (let sequence = 0; sequence < 500; sequence++) {
    const names = Array.from({ length: Math.floor(random() * 8) }, () => vocabulary[Math.floor(random() * vocabulary.length)]);
    const plan = buildItemPlan({ ...provider, labels: { nodes: names.map((name) => ({ name })) } }, {});
    const entry = { ...plan, identifier: provider.identifier, linearId: provider.id, match: { id: options.item } };
    const mutation = buildAtomicImportMutations("ENG", entry, settings.id_prefix, normalizeItemId).mutations.find((row) => row.op === "update");
    assert.ok(mutation?.op === "update" && typeof mutation.options.tags === "string");
    const canonical = canonicalDocument({ metadata: { ...reference, tags: plan.tags }, body: "" }, { schema: settings.schema });
    assert.deepEqual(parseTags(mutation.options.tags), canonical.metadata.tags ?? [], `tag producer sequence ${sequence}`);
  }
  for (const name of ["none", "a,b", "-", " Quoted \" Ω "]) {
    provider.labels = { nodes: [{ name }] };
    const expected = canonicalDocument({ metadata: { ...(await stateFromSdk(root, options.item)).metadata, tags: [name] }, body: "" }, { schema: settings.schema }).metadata.tags ?? [];
    for (const atomic of [true, false]) {
      await pm.update(options.item, { tags: '["peer"]', parent: "none", unset: ["goal", "objective", "sprint", "release"] });
      const result = await syncLinearIssues({ team: "ENG", limit: 1, atomic }, root);
      assert.equal(result.updated, 1); assert.equal(result.skipped, 0);
      assert.deepEqual((await stateFromSdk(root, options.item)).metadata.tags ?? [], expected, `${atomic}/${name}`);
    }
  }
  const foreign = await pm.create({ title: "Foreign focus", parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive" });
  await pm.update(options.item, { parent: "none", goal: foreign.item.id, objective: foreign.item.id, sprint: "sprint", release: "release" });
  await pm.focus(options.item);
  for (const atomic of [true, false]) {
    const actor = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: atomic ? "pm-linear" : "fixture" });
    await actor.focus(options.item);
    provider.id = `created-${atomic}`; provider.identifier = `NEW-${atomic}`; provider.labels = { nodes: [{ name: "none" }] };
    const result = await syncLinearIssues({ team: "ENG", limit: 1, atomic }, root);
    assert.equal(result.created, 1); assert.equal(result.skipped, 0);
    const index = indexItemsByLinearId((await pm.listAllComplete({ includeBody: true })).items);
    assert.ok(Object.hasOwn(index, provider.id));
    const actual = (await stateFromSdk(root, index[provider.id].id!)).metadata;
    assert.deepEqual(actual.tags, ["none"]);
    for (const field of ["parent", "goal", "objective", "sprint", "release"] as const) assert.equal(actual[field], undefined, `${atomic}/${field}`);
  }
});
