/** Explicit thread evidence against real non-git SDK trackers and a read-only HTTP fixture. */
import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { PmClient, readSettings, resolvePmRoot } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { captureLinearThread, ThreadCaptureRefusal, type ThreadCaptureOptions, type ThreadCaptureReport } from "../index.ts";

/** A provider-shaped comment with synthetic identity and attributed content. */
function comment(id = "root", parentId: string | null = null) {
  return { id, parentId, updatedAt: "2026-10-21T10:00:00.000Z", body: "Selected discussion evidence",
    user: { id: "author-1", name: "Synthetic author" }, externalUser: null as { id: string; name: string } | null };
}

/** Complete explicit thread, deliberately not an issue or workspace collection. */
function thread() {
  return { ...comment(), url: "https://linear.app/example/issue/ENG-1#comment-root",
    children: { nodes: [comment("reply", "root")], pageInfo: { hasNextPage: false, endCursor: null as string | null } } };
}

/** Allocate an isolated tracker and transport; remove git from PATH after initialization. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "linear-capture-"));
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" });
  await pm.init("capture-fixture");
  await pm.create({ title: "Existing context", id: "existing", createMode: "progressive" });
  const state = { node: thread() as unknown, errors: undefined as unknown, status: 200,
    respond: undefined as ((after: string | null, count: number) => unknown | Promise<unknown>) | undefined };
  const requests: Array<{ query: string; variables: { id: string; after: string | null } }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", async () => {
      const request = JSON.parse(raw) as typeof requests[number];
      requests.push(request);
      res.writeHead(state.status, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ data: { comment: state.respond ? await state.respond(request.variables.after, requests.length) : state.node }, errors: state.errors }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const changes = { LINEAR_API_KEY: "synthetic-key", LINEAR_API_BASE_URL: `http://127.0.0.1:${address.port}/graphql`,
    PATH: root, GIT_CEILING_DIRECTORIES: tmpdir() };
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  const options: ThreadCaptureOptions = { threadId: "root", itemId: "existing" };
  return { root, pm, state, requests, options };
}

/** Require stable error codes, nonempty remedies, and omission of transport secrets. */
function refused(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ThreadCaptureRefusal);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, 2);
    assert.ok(error.remedy.length > 20);
    assert.doesNotMatch(error.message, /synthetic-key|transport-secret/);
    return true;
  };
}

/** Hash every file in the explicitly supplied tracker copy, including possible read caches. */
async function hashes(root: string): Promise<string[]> {
  const names = (await readdir(root, { recursive: true })).sort();
  const results: string[] = [];
  for (const name of names) {
    if ((await stat(join(root, name))).isFile()) results.push(`${name}:${createHash("sha256").update(await readFile(join(root, name))).digest("hex")}`);
  }
  return results;
}

test("preview, reviewed apply, concurrent replay and edited source preserve existing item identity", async (t) => {
  const { root, pm, options, state, requests } = await fixture(t);
  const before = await pm.get("existing", { full: true });
  const plan = await captureLinearThread(options, root);
  assert.equal(plan.mode, "plan");
  assert.equal(plan.appended, 0);
  assert.equal(plan.commentCount, 2);
  assert.equal(plan.sourceChanged, false);
  assert.equal((await pm.notes("existing")).count, 0);
  assert.doesNotMatch(JSON.stringify(plan), /Selected discussion evidence|Synthetic author/);
  assert.equal(plan.proposedNote.comments[0].author.id, "author-1");
  const apply = { ...options, apply: true, revision: plan.revision };
  const receipts = await Promise.all([captureLinearThread(apply, root), captureLinearThread(apply, root)]);
  assert.equal(receipts.reduce((sum, report) => sum + report.appended, 0), 1);
  assert.equal(receipts.filter((report) => report.duplicate).length, 1);
  assert.equal((await captureLinearThread(options, root)).duplicate, true);
  const historyBefore = (await hashes(root)).filter((entry) => entry.includes(".jsonl:"));
  assert.equal((await captureLinearThread(apply, root)).appended, 0);
  assert.deepEqual((await hashes(root)).filter((entry) => entry.includes(".jsonl:")), historyBefore);
  const edited = thread(); edited.children.nodes[0].body = "Edited evidence, same timestamp";
  state.node = edited;
  await assert.rejects(captureLinearThread(apply, root), refused("source_changed"));
  assert.equal((await pm.notes("existing")).count, 1);
  const changed = await captureLinearThread(options, root);
  assert.equal(changed.sourceChanged, true);
  assert.equal(changed.previousSourceRevision, plan.proposedNote.sourceRevision);
  assert.notEqual(changed.revision, plan.revision);
  assert.equal((await captureLinearThread({ ...options, apply: true, revision: changed.revision }, root)).appended, 1);
  const notes = await pm.notes("existing", { eventType: "linear.thread-evidence.v1" });
  assert.equal(notes.count, 2);
  assert.ok(notes.notes.every((note) => note.format === "json" && note.author === "pm-linear"));
  assert.equal((await pm.get("existing")).item.status, before.item.status);
  assert.equal((await pm.listAllComplete()).count, 1);
  assert.ok(requests.every((request) => request.variables.id === "root" && !/mutation|issues\(|comments\(/.test(request.query)));
});

test("text is an explicit disclosure and changes invalidate the reviewed target and disclosure", async (t) => {
  const { root, pm, options, state } = await fixture(t);
  const meta = await captureLinearThread(options, root);
  const textOptions = { ...options, disclosure: "text" as const };
  const text = await captureLinearThread(textOptions, root);
  assert.equal(text.proposedNote.sourceRevision, meta.proposedNote.sourceRevision);
  assert.match(JSON.stringify(text), /Selected discussion evidence/);
  assert.match(JSON.stringify(text), /Synthetic author/);
  await assert.rejects(captureLinearThread({ ...textOptions, apply: true, revision: meta.revision }, root), refused("source_changed"));
  await pm.create({ title: "Another target", id: "other", createMode: "progressive" });
  await assert.rejects(captureLinearThread({ ...options, itemId: "other", revision: meta.revision }, root), refused("source_changed"));
  const external = thread(); external.user = null as unknown as typeof external.user;
  external.externalUser = { id: "external-author", name: "Synthetic external author" };
  external.children.nodes[0].user = null as unknown as typeof external.user;
  state.node = external;
  const attributed = await captureLinearThread(textOptions, root);
  assert.equal(attributed.proposedNote.comments.find((row) => row.id === "root")?.author.kind, "external");
  assert.equal(attributed.proposedNote.comments.find((row) => row.id === "reply")?.author.kind, "unknown");
  assert.equal((await captureLinearThread({ ...textOptions, apply: true, revision: attributed.revision }, root)).appended, 1);
  await assert.rejects(pm.notes("existing", { delete: 1 }), /append-only/);
});

test("reviewed capture tokens cannot cross trackers with the same item ID", async (t) => {
  const { root, pm, options } = await fixture(t);
  const secondRoot = join(root, "second-tracker");
  await mkdir(secondRoot);
  const second = new PmClient({ cwd: secondRoot, pmRoot: secondRoot, noExtensions: true, author: "fixture" });
  await second.init("capture-fixture");
  await second.create({ title: "Existing context", id: "existing", createMode: "progressive" });
  const firstStorage = resolvePmRoot(root, root);
  const secondStorage = resolvePmRoot(secondRoot, secondRoot);
  assert.equal((await readSettings(firstStorage)).id_prefix, (await readSettings(secondStorage)).id_prefix);
  const selection = { ...options, disclosure: "text" as const };
  const firstPlan = await captureLinearThread(selection, root);
  // Workspace/storage spelling and symlink aliases identify the same tracker.
  assert.equal((await captureLinearThread(selection, firstStorage)).revision, firstPlan.revision);
  const alias = join(root, "tracker-alias");
  await symlink(firstStorage, alias, "dir");
  assert.equal((await captureLinearThread(selection, alias)).revision, firstPlan.revision);
  const secondBefore = await hashes(secondStorage);
  await assert.rejects(captureLinearThread({ ...selection, apply: true, revision: firstPlan.revision }, secondRoot), refused("source_changed"));
  assert.deepEqual(await hashes(secondStorage), secondBefore);
  assert.equal((await second.notes("existing")).count, 0);
  const secondPlan = await captureLinearThread(selection, secondRoot);
  assert.notEqual(secondPlan.revision, firstPlan.revision);
  assert.deepEqual(secondPlan.proposedNote, firstPlan.proposedNote);
  assert.equal((await captureLinearThread({ ...selection, apply: true, revision: secondPlan.revision }, secondRoot)).appended, 1);
  assert.equal((await captureLinearThread({ ...selection, apply: true, revision: secondPlan.revision }, secondRoot)).appended, 0);
  assert.equal((await captureLinearThread({ ...selection, apply: true, revision: firstPlan.revision }, root)).appended, 1);
  assert.equal((await pm.notes("existing")).count, 1);
  assert.ok(!JSON.stringify(firstPlan).includes(root));
  assert.ok(!JSON.stringify(secondPlan).includes(secondRoot));
});

test("large unrelated note history cannot hide replay identity or source edits", async (t) => {
  const { root, pm, options } = await fixture(t);
  await pm.notes("existing", { addJson: JSON.stringify({ type: "linear.thread-evidence.v1", threadId: "another", context: "Unrelated context ".repeat(4096) }) });
  const plan = await captureLinearThread(options, root);
  assert.equal((await captureLinearThread({ ...options, apply: true, revision: plan.revision }, root)).appended, 1);
  const replay = await captureLinearThread({ ...options, apply: true, revision: plan.revision }, root);
  assert.equal(replay.appended, 0);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.previousSourceRevision, plan.proposedNote.sourceRevision);
});

test("malformed prior revisions refuse without disclosing arbitrary private note fields", async (t) => {
  const { root, pm, options } = await fixture(t);
  await pm.notes("existing", { author: "pm-linear", addJson: JSON.stringify({ type: "linear.thread-evidence.v1", threadId: "root", sourceRevision: "transport-secret" }) });
  await assert.rejects(captureLinearThread(options, root), refused("target_unavailable"));
});

test("registered command supports camel/kebab flags, native output objects and typed refusals", async (t) => {
  const { root, options } = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  for (const global of [{ json: true }, {}]) {
    const result = await harness.runCommand({ command: "linear capture", pmRoot: root, options: { thread: "root", item: "existing", "max-output-bytes": "8192" }, global });
    assert.deepEqual(result.result, await captureLinearThread(options, root));
  }
  const plan = await captureLinearThread(options, root);
  const applied = await harness.runCommand({ command: "linear capture", pmRoot: root, options: { thread: "root", item: "existing", apply: true, revision: plan.revision, maxOutputBytes: 8192 }, global: { json: true } });
  assert.equal((applied.result as ThreadCaptureReport).appended, 1);
  await assert.rejects(harness.runCommand({ command: "linear capture", pmRoot: root, options: {}, global: {} }), refused("selection_required"));
});

test("reply pagination completes and canonical ordering ignores transport order", async (t) => {
  const { root, options, state, requests } = await fixture(t);
  const normal = await captureLinearThread(options, root);
  state.respond = (after) => {
    const node = thread();
    if (!after) { node.children.nodes = []; node.children.pageInfo = { hasNextPage: true, endCursor: "next" }; node.children.nodes.push(comment("reply", "root")); }
    else node.children.nodes = [];
    return node;
  };
  const paged = await captureLinearThread(options, root);
  assert.equal(paged.revision, normal.revision);
  assert.ok(requests.some(({ variables }) => variables.after === "next"));
});

for (const [name, change, code] of [
  ["null root", () => null, "source_incomplete"],
  ["array root", () => [], "source_incomplete"],
  ["selected reply", () => ({ ...thread(), parentId: "parent" }), "selection_required"],
  ["wrong identity", () => ({ ...thread(), id: "other" }), "selection_required"],
  ["bad URL", () => ({ ...thread(), url: "https://example.invalid/private?transport-secret" }), "source_incomplete"],
  ["missing timestamp", () => ({ ...thread(), updatedAt: "" }), "source_incomplete"],
  ["invalid timestamp", () => ({ ...thread(), updatedAt: "yesterday" }), "source_incomplete"],
  ["invalid body", () => ({ ...thread(), body: null }), "source_incomplete"],
  ["oversize body", () => ({ ...thread(), body: "x".repeat(65537) }), "source_incomplete"],
  ["missing author", () => ({ ...thread(), user: undefined }), "source_incomplete"],
  ["invalid name", () => ({ ...thread(), user: { id: "user", name: "" } }), "source_incomplete"],
  ["unrelated reply", () => ({ ...thread(), children: { nodes: [comment("reply", "other")], pageInfo: { hasNextPage: false, endCursor: null } } }), "source_incomplete"],
  ["duplicate reply", () => ({ ...thread(), children: { nodes: [comment("reply", "root"), comment("reply", "root")], pageInfo: { hasNextPage: false, endCursor: null } } }), "source_incomplete"],
  ["missing connection", () => ({ ...thread(), children: undefined }), "source_incomplete"],
  ["invalid nodes", () => ({ ...thread(), children: { nodes: null, pageInfo: {} } }), "source_incomplete"],
  ["invalid flag", () => ({ ...thread(), children: { nodes: [], pageInfo: { hasNextPage: 1, endCursor: null } } }), "source_incomplete"],
  ["invalid cursor", () => ({ ...thread(), children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: 1 } } }), "source_incomplete"],
  ["empty next page", () => ({ ...thread(), children: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "next" } } }), "source_incomplete"],
  ["missing next cursor", () => ({ ...thread(), children: { nodes: [comment("reply", "root")], pageInfo: { hasNextPage: true, endCursor: null } } }), "source_incomplete"],
  ["oversize thread", () => ({ ...thread(), children: { nodes: Array.from({ length: 100 }, (_, i) => comment(`reply-${i}`, "root")), pageInfo: { hasNextPage: false, endCursor: null } } }), "budget_exceeded"],
] satisfies Array<[string, () => unknown, string]>) {
  test(`${name} refuses incomplete evidence without writing`, async (t) => {
    const { root, pm, options, state } = await fixture(t);
    state.node = change();
    await assert.rejects(captureLinearThread(options, root), refused(code));
    assert.equal((await pm.notes("existing")).count, 0);
  });
}

test("access errors and unreachable provider omit private diagnostics", async (t) => {
  const { root, options, state } = await fixture(t);
  for (const status of [401, 403]) {
    state.status = status;
    await assert.rejects(captureLinearThread(options, root), refused("access_denied"));
  }
  state.status = 200; state.errors = [{ message: "transport-secret synthetic-key" }];
  await assert.rejects(captureLinearThread(options, root), refused("access_denied"));
  delete process.env.LINEAR_API_KEY;
  await assert.rejects(captureLinearThread(options, root), refused("access_denied"));
});

for (const fault of ["loop", "root edit", "reply edit", "empty continuation"] as const) {
  test(`source ${fault} refuses before writing`, async (t) => {
    const { root, options, state } = await fixture(t);
    state.respond = (_after, count) => {
      const node = thread();
      if (fault === "reply edit" && count === 2) node.children.nodes[0].body = "Changed on verification";
      if (fault !== "reply edit") {
        if (fault === "empty continuation") node.children.nodes = [];
        else node.children.nodes = [comment(`reply-${count}`, "root")];
        node.children.pageInfo = { hasNextPage: true, endCursor: fault === "loop" ? "repeated" : `next-${count}` };
        if (fault === "root edit" && count === 2) node.body = "Changed while paging";
      }
      return node;
    };
    await assert.rejects(captureLinearThread(options, root), refused(fault === "root edit" || fault === "reply edit" ? "source_changed" : "source_incomplete"));
  });
}

test("selection, review, output and target refusals happen before mutations", async (t) => {
  const { root, pm, options, requests } = await fixture(t);
  for (const patch of [{ threadId: "" }, { itemId: "" }, { threadId: undefined }, { disclosure: "all" }, { apply: "yes" }]) {
    await assert.rejects(captureLinearThread({ ...options, ...patch } as ThreadCaptureOptions, root), refused("selection_required"));
  }
  for (const maxOutputBytes of [0, 1.5, 65537, NaN]) await assert.rejects(captureLinearThread({ ...options, maxOutputBytes }, root), refused("budget_exceeded"));
  await assert.rejects(captureLinearThread({ ...options, apply: true }, root), refused("review_required"));
  await assert.rejects(captureLinearThread({ ...options, itemId: "missing" }, root), refused("target_unavailable"));
  assert.equal(requests.length, 0);
  await assert.rejects(captureLinearThread({ ...options, maxOutputBytes: 1024 }, root), refused("budget_exceeded"));
  const plan = await captureLinearThread(options, root);
  await pm.delete("existing", { reason: "Synthetic target disappeared" });
  await assert.rejects(captureLinearThread({ ...options, apply: true, revision: plan.revision }, root), refused("target_unavailable"));
});

test("target removal during source verification reports uncertain delivery with safe retry", async (t) => {
  const { root, pm, options, state } = await fixture(t);
  const plan = await captureLinearThread(options, root);
  let count = 0;
  state.respond = async () => {
    if (++count === 2) await pm.delete("existing", { reason: "Synthetic concurrent removal" });
    return thread();
  };
  await assert.rejects(captureLinearThread({ ...options, apply: true, revision: plan.revision }, root), refused("write_unconfirmed"));
});

test("public tracker validation uses a read-only non-git copy and reports aggregates only", async (t) => {
  const { root, pm, options, state } = await fixture(t);
  const source = process.env.PM_LINEAR_PUBLIC_TRACKER;
  const sourcePm = source ? new PmClient({ pmRoot: source, noExtensions: true }) : pm;
  if (source) {
    assert.equal((await stat(source)).mode & 0o222, 0, "public source copy must be read-only");
    await assert.rejects(stat(join(source, ".git")));
  }
  const before = source ? await hashes(source) : [];
  const corpus = await sourcePm.listAllComplete();
  const sample = corpus.items.slice(0, 20);
  let appended = 0;
  let duplicates = 0;
  let changed = 0;
  let bytes = 0;
  for (const [index, item] of sample.entries()) {
    const node = thread(); node.id = `public-${index}`; node.children.nodes = []; node.body = item.title;
    state.node = node;
    const selected = { ...options, threadId: node.id };
    const plan = await captureLinearThread(selected, root);
    bytes = Math.max(bytes, Buffer.byteLength(JSON.stringify(plan)));
    const applied = await captureLinearThread({ ...selected, apply: true, revision: plan.revision }, root);
    appended += applied.appended;
    duplicates += Number((await captureLinearThread({ ...selected, apply: true, revision: plan.revision }, root)).duplicate);
    node.body += " [public-data validation edit]";
    changed += Number((await captureLinearThread(selected, root)).sourceChanged);
  }
  assert.equal(appended, sample.length); assert.equal(duplicates, sample.length); assert.equal(changed, sample.length);
  if (source) assert.deepEqual(await hashes(source), before, "source copy bytes must be unchanged");
  console.log(JSON.stringify({ publicTracker: Boolean(source), corpusItems: corpus.count, sampledThreads: sample.length,
    appended, duplicates, sourceEditsVisible: changed, maxJsonBytes: bytes, unchangedSourceFiles: before.length, gitRequired: false }));
});
