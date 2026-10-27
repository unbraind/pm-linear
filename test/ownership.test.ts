/** Ownership previews use real SDK trackers, an observable wire, and no git executable. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalDocument, locateItem, PmClient, readLocatedItem, readSettings, type ItemMetadata } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildItemPlan, itemToLinearPayload, LINEAR_OWNERSHIP_FIELDS, LinearOwnershipRefusal, parseStatusMap, previewLinearOwnership, type LinearIssue, type LinearOwnershipOptions, type LinearOwnershipSnapshot } from "../index.ts";

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
  const state = { issue: issue() as unknown, errors: undefined as unknown, status: 200, requests: [] as string[], onRead: undefined as (() => Promise<void>) | undefined };
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
      res.end(JSON.stringify({ data: { issue: state.issue }, errors: state.errors }));
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
  for (const extra of [{ unknown: true }, { base: null }, { statusMap: [] }, { base: { fields: new Array(8) } }]) {
    await assert.rejects(previewLinearOwnership({ ...options, ...extra } as LinearOwnershipOptions, root), refused("invalid_input"));
  }
  assert.equal(state.requests.length, 0);
  const native = issue();
  for (const patch of [{ priority: Infinity }, { priority: 0.5 }, { estimate: -1 }, { estimate: 1000001 }, { labels: { nodes: new Array(1), pageInfo: { hasNextPage: false } } }, { labels: { nodes: [], pageInfo: { hasNextPage: true } } }, { state: { name: "Unknown", type: "mystery" } }, { title: "x".repeat(32769) }, { id: "other" }, { extra: true }]) {
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
    else { const next = issue(); next.title = `Provider ${sequence}`; next.description = sequence % 2 ? "\r\n Body " : "Body "; next.estimate = sequence / 2; next.dueDate = sequence % 2 ? null : "2026-12-01"; next.assignee = sequence % 2 ? null : { name: "Peer", email: null }; state.issue = next; }
    const base = random() < 0.4 ? history[Math.floor(random() * history.length)] : baseline;
    const before = await stateFromSdk(root, options.item);
    const local = hashes(before);
    const settings = await readSettings(root);
    const plan = buildItemPlan(state.issue as LinearIssue, {});
    // A reference import replaces every mapped field; omitted assignments clear
    // mapped optional values instead of inheriting the previous local value.
    const retained = Object.fromEntries(Object.entries(before.metadata).filter(([key]) => !LINEAR_OWNERSHIP_FIELDS.some((field) => field === key)));
    const remote = hashes(canonicalDocument({ metadata: { ...retained, ...plan, id: before.metadata.id } as ItemMetadata, body: plan.body }, { schema: settings.schema }));
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

test("custom status roles and aliases normalize mappings; misleading provider names do not decide lifecycle", async (t) => {
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
  await pm.update(options.item, { status: "open" });
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
