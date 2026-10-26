/** Focused acquisition uses real SDK trackers, bounded HTTP reads and no Git executable. */
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildProvenance, fetchLinearDependencyClosure, LinearClosureRefusal,
  type LinearClosureOptions, type LinearClosureReport } from "../index.ts";

/** Incoming blocks rows point from the prerequisite toward the requested issue. */
function issue(id: string, blockers: string[] = []) {
  return { id, identifier: `ENG-${id}`, title: `Issue ${id}`, updatedAt: "2026-10-21T00:00:00Z",
    inverseRelations: { nodes: blockers.map((blocker) => ({ id: `edge-${id}-${blocker}`, type: "blocks",
      issue: { id: blocker } as { id: string } | null, relatedIssue: { id } })),
      pageInfo: { hasNextPage: false, endCursor: null as string | null } } };
}

/** Names and byte hashes detect new files as well as edits anywhere in the temp tracker. */
async function snapshot(root: string) {
  const hash = createHash("sha256");
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(join(entry.parentPath, entry.name).slice(root.length));
    hash.update(await readFile(join(entry.parentPath, entry.name)));
  }
  return hash.digest("hex");
}

/** Local HTTP interception changes provider data only; every SDK read remains real. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "linear-closure-"));
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" });
  await pm.init("closure-fixture");
  await pm.create({ id: "selected", title: "Selected", description: buildProvenance({ id: "a", identifier: "ENG-a" }), createMode: "progressive" });
  const state = { status: 200, raw: undefined as string | undefined,
    respond: async (id: string, _after: string | null): Promise<unknown> =>
      ({ data: { issue: issue(id, ({ a: ["b"], b: ["c"], c: ["d"] } as Record<string, string[]>)[id] ?? []) } }) };
  const requests: Array<{ query: string; variables: { id: string; after: string | null } }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", async () => {
      const request = JSON.parse(raw) as typeof requests[number];
      requests.push(request);
      res.writeHead(state.status, { "Content-Type": "application/json", Connection: "close" });
      res.end(state.raw ?? JSON.stringify(await state.respond(request.variables.id, request.variables.after)));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const vars = { LINEAR_API_KEY: "synthetic-key", LINEAR_API_BASE_URL: `http://127.0.0.1:${address.port}/graphql`,
    PATH: root, GIT_CEILING_DIRECTORIES: tmpdir() };
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await rm(root, { recursive: true, force: true });
  });
  const options: LinearClosureOptions = { items: ["selected"] };
  return { root, pm, options, state, requests };
}

/** Failures expose bounded categories and actionable remedies, without transport or storage details. */
function refused(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof LinearClosureRefusal);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, 2);
    assert.ok(error.remedy.length > 20);
    assert.doesNotMatch(error.message, /synthetic-key|transport-secret|\/tmp\//);
    return true;
  };
}

test("three-hop exact frontier, SDK/CLI parity, imported membership, cycles and zero writes without git", async (t) => {
  const { root, pm, options, requests, state } = await fixture(t);
  const before = await snapshot(root);
  const result = await fetchLinearDependencyClosure(options, root);
  assert.equal(result.complete, true);
  assert.deepEqual(result.frontier, ["b", "c", "d"]);
  assert.deepEqual(result.measured, { nodes: 4, requests: 4, relations: 3 });
  assert.deepEqual(result.issues.map((row) => row.depth), [0, 1, 2, 3]);
  assert.ok(result.issues.every((row) => row.read));
  assert.deepEqual(await snapshot(root), before);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  for (const global of [{ json: true }, {}]) {
    const cli = await harness.runCommand({ command: "linear closure", pmRoot: root,
      options: { items: "selected", "max-depth": "3", maxNodes: 32, "max-requests": 64, maxRelations: 128, maxOutputBytes: 16384 }, global });
    assert.deepEqual(cli.result, result);
  }
  assert.equal(await snapshot(root), before);
  await pm.create({ id: "imported", title: "Imported", description: buildProvenance({ id: "b", identifier: "ENG-b" }), createMode: "progressive" });
  state.respond = async (id) => ({ data: { issue: issue(id, { a: ["b"], b: ["c"], c: ["a", "c"] }[id] ?? []) } });
  const cycle = await fetchLinearDependencyClosure(options, root);
  assert.equal(cycle.complete, true);
  assert.deepEqual(cycle.frontier, ["c"]);
  assert.equal(cycle.issues.find((row) => row.id === "b")?.localId, "closure-fixture-imported");
  assert.ok(requests.every((row) => !/mutation|teams\(|issues\(/.test(row.query) && row.query.includes("inverseRelations")));
  const multi = await fetchLinearDependencyClosure({ items: ["selected", "imported"] }, root);
  assert.deepEqual(multi.selected, ["a", "b"]);
  assert.equal(multi.issues.find((row) => row.id === "b")?.depth, 0);
});

test("depth/node/request/relation caps preserve explicit unresolved boundaries without exceeding a budget", async (t) => {
  const { root, options, requests, state } = await fixture(t);
  for (const [control, value, reason] of [["maxDepth", 1, "depth_cap"], ["maxNodes", 2, "node_cap"],
    ["maxRequests", 1, "request_cap"], ["maxRelations", 1, "relation_cap"]] as const) {
    const offset = requests.length;
    const report = await fetchLinearDependencyClosure({ ...options, [control]: value }, root);
    assert.equal(report.complete, false);
    assert.ok(report.boundaries.some((row) => row.reason === reason && row.remedy.length > 20));
    assert.equal(requests.length - offset, report.measured.requests);
    assert.ok(report.measured.nodes <= report.caps.nodes && report.measured.requests <= report.caps.requests && report.measured.relations <= report.caps.relations);
  }
  const zero = await fetchLinearDependencyClosure({ ...options, maxDepth: 0 }, root);
  assert.equal(zero.issues.length, 1);
  assert.equal(zero.boundaries[0].id, "b");
  state.respond = async (id) => ({ data: { issue: { ...issue(id, id === "a" ? ["b"] : []), title: "x".repeat(1024) } } });
  await assert.rejects(fetchLinearDependencyClosure({ ...options, maxOutputBytes: 1024 }, root), refused("output_budget"));
});

test("access failures and unknown blocker identities remain unresolved; HTTP failures never retry", async (t) => {
  const { root, options, state, requests } = await fixture(t);
  for (const status of [401, 403, 429, 500]) {
    state.status = status;
    const count = requests.length;
    const report = await fetchLinearDependencyClosure(options, root);
    assert.equal(report.complete, false);
    assert.equal(report.measured.requests, 1);
    assert.equal(requests.length, count + 1);
    assert.equal(report.boundaries[0].reason, status < 429 ? "access_denied" : "unavailable");
  }
  state.status = 200;
  state.respond = async (id) => id === "a" ? { data: { issue: issue(id, ["b"]) } } : { data: { issue: null } };
  const inaccessible = await fetchLinearDependencyClosure(options, root);
  assert.deepEqual(inaccessible.frontier, ["b"]);
  assert.equal(inaccessible.issues[1].read, false);
  assert.equal(inaccessible.boundaries[0].id, "b");
  state.respond = async () => ({ errors: [{ message: "transport-secret" }], data: { issue: issue("a") } });
  assert.equal((await fetchLinearDependencyClosure(options, root)).boundaries[0].reason, "access_denied");
  state.respond = async () => { const row = issue("a", ["b"]); row.inverseRelations.nodes[0].issue = null; return { data: { issue: row } }; };
  assert.equal((await fetchLinearDependencyClosure(options, root)).complete, false);
  state.raw = "invalid JSON";
  assert.equal((await fetchLinearDependencyClosure(options, root)).boundaries[0].reason, "unavailable");
  state.raw = "x".repeat(300000);
  assert.equal((await fetchLinearDependencyClosure(options, root)).boundaries[0].reason, "unavailable");
});

test("pagination checks direction, duplicates, cursor progress and source revision", async (t) => {
  const { root, options, state } = await fixture(t);
  state.respond = async (id, after) => {
    const row = issue(id, id === "a" && !after ? ["b"] : []);
    if (id === "a" && !after) row.inverseRelations.pageInfo = { hasNextPage: true, endCursor: "next" };
    return { data: { issue: row } };
  };
  assert.equal((await fetchLinearDependencyClosure(options, root)).measured.requests, 3);
  for (const variant of ["wrong-id", "wrong-direction", "duplicates", "cursor-null", "cursor-loop", "empty-page", "changed"] as const) {
    state.respond = async (id, after) => {
      const row = issue(id, ["b"]);
      if (variant === "wrong-id") row.id = "other";
      if (variant === "wrong-direction") row.inverseRelations.nodes[0].relatedIssue.id = "other";
      if (variant === "duplicates") row.inverseRelations.nodes.push(row.inverseRelations.nodes[0]);
      if (variant.startsWith("cursor") || variant === "empty-page" || variant === "changed") {
        row.inverseRelations.pageInfo = { hasNextPage: true, endCursor: variant === "cursor-null" ? null : "next" };
        if (after) row.inverseRelations.nodes = [];
        if (variant === "empty-page") row.inverseRelations.nodes = [];
        if (variant === "changed" && after) row.title = "changed";
      }
      return { data: { issue: row } };
    };
    await assert.rejects(fetchLinearDependencyClosure(options, root), refused(variant === "changed" ? "source_changed" : "source_invalid"));
  }
  state.respond = async () => { const row = issue("a", ["b"]); row.inverseRelations.nodes[0].type = "related"; return { data: { issue: row } }; };
  assert.deepEqual((await fetchLinearDependencyClosure(options, root)).frontier, []);
});

test("strict boundary schemas reject extreme options, malformed provider rows and sparse arrays", async (t) => {
  const { root, options, state, requests } = await fixture(t);
  for (const value of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_VALUE, Number.MIN_VALUE, "3", null, [], {}]) {
    for (const key of ["maxDepth", "maxNodes", "maxRequests", "maxRelations", "maxOutputBytes"]) {
      await assert.rejects(fetchLinearDependencyClosure({ ...options, [key]: value } as LinearClosureOptions, root), refused("invalid_input"));
    }
  }
  for (const items of [new Array<string>(1), [""], ["a b"], Array(17).fill("selected")]) {
    await assert.rejects(fetchLinearDependencyClosure({ items }, root), refused("invalid_input"));
  }
  await assert.rejects(fetchLinearDependencyClosure({ ...options, foreign: true } as LinearClosureOptions, root), refused("invalid_input"));
  for (const items of [[], ["selected", "selected"], ["selected", "missing"]]) {
    await assert.rejects(fetchLinearDependencyClosure({ items, maxNodes: 1 }, root), refused("selection_required"));
  }
  await assert.rejects(fetchLinearDependencyClosure({ items: ["missing"] }, root), refused("selection_required"));
  delete process.env.LINEAR_API_KEY;
  await assert.rejects(fetchLinearDependencyClosure(options, root), refused("selection_required"));
  process.env.LINEAR_API_KEY = "synthetic-key";
  assert.equal(requests.length, 0);
  for (const envelope of [null, [], false, 1]) {
    state.raw = JSON.stringify(envelope);
    await assert.rejects(fetchLinearDependencyClosure(options, root), refused("source_invalid"));
  }
  state.raw = undefined;
  for (const row of [undefined, [], false, "issue", 1, {}, { ...issue("a"), title: "" },
    { ...issue("a"), extra: true }, { ...issue("a"), inverseRelations: { nodes: [null], pageInfo: { hasNextPage: false, endCursor: null } } },
    { ...issue("a"), inverseRelations: { nodes: Array(51).fill(null), pageInfo: { hasNextPage: false, endCursor: null } } }]) {
    state.respond = async () => ({ data: { issue: row } });
    await assert.rejects(fetchLinearDependencyClosure(options, root), refused("source_invalid"));
  }
});

test("concurrent preview readers have independent budgets and reject a competing local transition", async (t) => {
  const { root, pm, options, state } = await fixture(t);
  const before = await snapshot(root);
  const reports = await Promise.all(Array.from({ length: 3 }, () => fetchLinearDependencyClosure(options, root)));
  assert.ok(reports.every((row) => row.complete && row.measured.requests === 4));
  assert.equal(await snapshot(root), before);
  for (let step = 0; step < 4; step++) {
    let position = 0;
    state.respond = async (id) => {
      if (position++ === step) await pm.update("selected", { title: `Peer revision ${step}` });
      return { data: { issue: issue(id, ({ a: ["b"], b: ["c"], c: ["d"] } as Record<string, string[]>)[id] ?? []) } };
    };
    await assert.rejects(fetchLinearDependencyClosure(options, root), refused("source_changed"));
    assert.equal((await pm.get("selected")).item.title, `Peer revision ${step}`);
  }
  await pm.create({ id: "duplicate", title: "Duplicate", description: buildProvenance({ id: "a", identifier: "ENG-a" }), createMode: "progressive" });
  await assert.rejects(fetchLinearDependencyClosure(options, root), refused("local_read_failed"));
});

/** A seeded independent reachability oracle; it has no provider pagination or package normalization. */
function expected(graph: Map<string, string[]>) {
  const visited = new Set(["a"]);
  for (const id of visited) for (const blocker of graph.get(id) ?? []) visited.add(blocker);
  return [...visited];
}

test("500 seeded random operation sequences replay older provider graphs and read native state back through the SDK", async (t) => {
  const { root, pm, options, state } = await fixture(t);
  await pm.create({ id: "foreign", title: "Foreign prerequisite", createMode: "progressive" });
  await pm.update("selected", { body: " Body with whitespace\r\nand CRLF ", priority: 3,
    tags: "context,foreign", deadline: "2026-12-01", assignee: "fixture-agent",
    dep: ["id=foreign,kind=blocked_by"] });
  let seed = 0x193740ab;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const graphs: Map<string, string[]>[] = [];
  // Each sequence has graph edit, historical replay, CRLF/whitespace and foreign-field changes.
  for (let sequence = 0; sequence < 500; sequence++) {
    if (sequence % 50 === 0) {
      const status = `custom_${Math.floor(random() * 1000000)}`;
      const role = ["active", "blocked", "draft", "terminal_done", "terminal_canceled"][Math.floor(random() * 5)];
      await pm.schemaAddStatus(status, { role: [role] });
      await pm.update("selected", { status, closeReason: "Synthetic lifecycle evidence" });
    }
    const graph = new Map(["a", "b", "c", "d"].map((id) => [id, ["a", "b", "c", "d"].filter(() => random() < 0.3)]));
    graphs.push(graph);
    const replay = graphs[Math.floor(random() * graphs.length)];
    for (const source of [graph, replay]) {
      state.respond = async (id) => {
        const row = issue(id, source.get(id) ?? []);
        row.title = sequence % 2 ? ` Context ${id}\r\n evidence ` : `Context ${id}`;
        return { data: { issue: row } };
      };
      const before = await pm.get("selected", { full: true });
      const report: LinearClosureReport = await fetchLinearDependencyClosure(options, root);
      assert.equal(report.complete, true);
      assert.deepEqual(new Set(report.issues.map((row) => row.id)), new Set(expected(source)));
      assert.deepEqual(new Set(report.frontier), new Set(expected(source).filter((id) => id !== "a")));
      assert.deepEqual((await pm.get("selected", { full: true })).item, before.item);
      assert.ok(report.issues.every((row) => Number.isFinite(row.depth) && row.depth >= 0 && row.depth <= report.caps.depth));
    }
  }
});


test("read-only source modes and foreign symlink entries cannot cause source writes", async (t) => {
  const { root, options } = await fixture(t);
  const entries = (await readdir(root, { recursive: true, withFileTypes: true }));
  for (const entry of entries) await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o555 : 0o444);
  await chmod(root, 0o555);
  const before = await snapshot(root);
  assert.equal((await fetchLinearDependencyClosure(options, root)).complete, true);
  assert.equal(await snapshot(root), before);
  await chmod(root, 0o700);
  for (const entry of entries) await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600);
  const linked = join(root, "tasks", "foreign.toon");
  await symlink(join(root, "settings.json"), linked);
  await assert.rejects(fetchLinearDependencyClosure(options, root), refused("local_read_failed"));
  await rm(linked);
  await writeFile(join(root, "tasks", "broken.toon"), "[invalid");
  await assert.rejects(fetchLinearDependencyClosure(options, root), refused("local_read_failed"));
});
