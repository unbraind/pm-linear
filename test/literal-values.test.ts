/** Literal-value regressions use real SDK state, real imports and no git or pm executable. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalDocument, locateItem, normalizeItemId, PmClient, readLocatedItem, readSettings, type ItemMetadata } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildAtomicImportMutations, buildItemPlan, importLinearForwardOnly, LinearImportRefusal, previewLinearOwnership, syncLinearIssues, type LinearIssue, type LinearOwnershipSnapshot } from "../index.ts";

/** Every provider field exercised by the shared import projection. */
function provider(): LinearIssue & { updatedAt: string } {
  return { id: "literal-provider", identifier: "LIT-1", title: "Literal values", description: "Body", priority: 2,
    state: { name: "Queue", type: "unstarted" }, labels: { nodes: [], pageInfo: { hasNextPage: false } } as LinearIssue["labels"],
    dueDate: "2026-12-01", cycle: null, estimate: null, customer: null, project: null,
    assignee: { name: "agent", email: null }, updatedAt: "2026-10-27T00:00:00Z" };
}

/** Isolated tracker plus bounded provider fixture; PATH contains neither git nor pm. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "linear-literal-"));
  const pm = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: "fixture" });
  await pm.init("literal");
  const state = { issue: provider(), requests: 0 };
  const plan = buildItemPlan(state.issue, {});
  const created = await pm.create({ ...plan, tags: "[]", parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive" });
  const id = created.item.id;
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      const { query } = JSON.parse(raw) as { query: string }; assert.ok(!query.trimStart().startsWith("mutation")); state.requests++;
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      const pageInfo = { hasNextPage: false, endCursor: null };
      const data = query.includes("LinearSchema") ? {
        teams: { nodes: [{ id: "team", key: "LIT", cyclesEnabled: false, triageEnabled: false, issueEstimationType: "notUsed", defaultIssueState: null,
          states: { nodes: [{ id: "state", ...state.issue.state }], pageInfo } }] },
        issueLabels: { nodes: state.issue.labels.nodes.map((label, index) => ({ id: `label-${index}`, name: label.name })), pageInfo },
      } : query.includes("issues(") ? { issues: { nodes: [state.issue], pageInfo } } : { issue: state.issue };
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const changes = { LINEAR_API_KEY: "synthetic-key", LINEAR_API_BASE_URL: `http://127.0.0.1:${addr.port}/graphql`, PATH: root, GIT_CEILING_DIRECTORIES: tmpdir() };
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]])); Object.assign(process.env, changes);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true });
  });
  return { root, pm, state, id };
}

/** Read native documents back through the SDK, never through a handwritten normalizer. */
async function document(root: string, id: string) {
  const located = await locateItem(root, id); assert.ok(located);
  return (await readLocatedItem(located, { schema: (await readSettings(root)).schema })).document;
}

/** Refusals identify the field without exposing provider data, and never claim success. */
function refused(field: string) {
  return (error: unknown) => {
    assert.ok(error instanceof LinearImportRefusal); assert.equal(error.code, "unrepresentable_value"); assert.equal(error.field, field);
    assert.equal(error.exitCode, 2); assert.match(error.remedy, /1614/); return true;
  };
}

test("literal class: every import and preview boundary refuses SDK controls before any item writes", async (t) => {
  const { root, pm, state, id } = await fixture(t);
  const before = (await pm.listAllComplete({ includeBody: true })).items;
  const settings = await readSettings(root);
  const normal = buildItemPlan(state.issue, {});
  for (const [field, value] of [["body", "-"], ["body", " \r\n-\t"], ["description", "-"], ["title", ""], ["assignee", "none"], ["assignee", " NULL "], ["assignee", ""], ["deadline", "none"], ["deadline", ""], ["deadline", "-"], ["deadline", "@file"], ["deadline", "--"], ["deadline", "tomorrow"], ["deadline", "2026-02-30"], ["deadline", "2026-99-99"]] as const) {
    const entry = { ...normal, [field]: value, linearId: state.issue.id, identifier: state.issue.identifier, match: { id } };
    assert.throws(() => buildAtomicImportMutations("LIT", entry, settings.id_prefix, normalizeItemId), refused(field));
    await assert.rejects(importLinearForwardOnly(root, "LIT", [entry]), refused(field));
  }
  for (const field of ["title", "body", "description", "assignee", "deadline"]) for (const value of [null, 42, [], {}]) {
    const entry = { ...normal, [field]: value, linearId: state.issue.id, identifier: state.issue.identifier };
    assert.throws(() => buildAtomicImportMutations("LIT", entry as unknown as Parameters<typeof buildAtomicImportMutations>[1], settings.id_prefix, normalizeItemId), refused(field));
  }
  assert.throws(() => buildAtomicImportMutations("LIT", null as unknown as Parameters<typeof buildAtomicImportMutations>[1], settings.id_prefix, normalizeItemId), refused("record"));
  for (const [field, mutate] of [
    ["body", () => { state.issue.description = "-"; }],
    ["assignee", () => { state.issue.assignee = { name: "NoNe", email: null }; }],
  ] as const) {
    state.issue = provider(); mutate();
    assert.throws(() => buildItemPlan(state.issue, {}), refused(field));
    for (const atomic of [true, false]) {
      for (const reverse of [false, true]) {
        const rows = [provider(), state.issue];
        if (reverse) rows.reverse();
        await assert.rejects(syncLinearIssues({ team: "LIT", limit: 2, atomic, forwardOnly: true }, root, { fetchIssues: async () => rows }), refused(field));
      }
    }
    await assert.rejects(previewLinearOwnership({ item: id }, root), refused(field));
  }
  assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, before);
});

test("literal class: JSON and TOON dispatch preserve typed literal refusals through both import aliases", async (t) => {
  const { root, state, id } = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  for (const field of ["body", "assignee"]) {
    state.issue = provider(); if (field === "body") state.issue.description = "-"; else state.issue.assignee = { name: "none", email: null };
    for (const global of [{ json: true }, {}]) {
      for (const run of [
        () => harness.runCommand({ command: "linear ownership", pmRoot: root, options: { item: id }, global }),
        ...[true, false].flatMap((atomic) => [
          () => harness.runCommand({ command: "linear sync", pmRoot: root, options: { team: "LIT", atomic, forwardOnly: true }, global }),
          ...["linear", "linear-sync"].map((importer) => () => harness.runImporter({ importer, pmRoot: root, options: { team: "LIT", atomic, forwardOnly: true }, global })),
        ]),
      ]) {
        const result = await run(); assert.equal(result.exitCode, 2); assert.equal(result.errorCode, "unrepresentable_value");
        assert.equal((result.result as { field: string }).field, field);
      }
    }
  }
});

test("literal class: actual import workers never consume caller stdin", async (t) => {
  const { root } = await fixture(t);
  for (const atomic of [true, false]) for (const field of ["body", "assignee", "safe"]) {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "literal-stdin-worker.ts"), root, String(atomic), field], {
      encoding: "utf8", input: "caller-stdin-is-not-provider-data\n", timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).passed, true);
  }
});

test("literal class: leading-dash titles and @file values remain data in both typed writers", async (t) => {
  const { root, state, pm } = await fixture(t);
  for (const atomic of [true, false]) for (const [index, title] of ["-", "--", "--title", "@file", "none", "null"].entries()) {
    state.issue = provider(); state.issue.id = `new-${atomic}-${index}`; state.issue.identifier = `LIT-${atomic}-${index}`; state.issue.title = title;
    const result = await syncLinearIssues({ team: "LIT", limit: 1, atomic, forwardOnly: true, fieldMap: { identifier: "ignore" } }, root, { fetchIssues: async () => [state.issue] });
    assert.equal(result.created, 1); assert.equal(result.skipped, 0);
    const item = (await pm.listAllComplete({ includeBody: true })).items.find((item) => item.description?.includes(`linear_id=${state.issue.id} `) || item.description === `[linear] linear_id=${state.issue.id}`);
    assert.ok(item); assert.equal(item.title, title);
  }
});

test("literal class: 500 seeded imports round-trip literal values and agree with acknowledged previews", async (t) => {
  const { root, pm, state, id } = await fixture(t);
  const foreign = await pm.create({ title: "Foreign focus", parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive" });
  await pm.update(id, { parent: foreign.item.id, goal: foreign.item.id, objective: foreign.item.id, sprint: "sprint", release: "release" });
  const relationships = (await document(root, id)).metadata;
  const history: LinearOwnershipSnapshot[] = [];
  const all = ["-", "none", "null", "NoNe", "NULL", "@file", "--", "--force", "-leading", "", "literal Ω", "line" + String.fromCharCode(13, 10) + "value"];
  const bodies = all.filter((value) => value !== "-");
  const assignees = ["-", "@file", "--", "--force", "-leading", "none-user", "null-user", "agent", ""];
  let seed = 0x16141027;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let sequence = 0; sequence < 500; sequence++) {
    if (sequence % 100 === 0) t.diagnostic(`literal seed 0x16141027: sequence ${sequence}/500`);
    const atomic = sequence % 2 === 0;
    if (sequence % 25 === 0) await pm.focus(random() < 0.5 ? id : foreign.item.id);
    state.issue = provider(); state.issue.title = all[Math.floor(random() * all.length)] || "empty source title";
    state.issue.description = all[Math.floor(random() * all.length)];
    state.issue.assignee = { name: all[Math.floor(random() * all.length)], email: null };
    const unsupported = state.issue.description === "-" ? "body" : ["none", "null"].includes(state.issue.assignee.name!.toLowerCase()) ? "assignee" : undefined;
    if (unsupported) {
      const beforeRefusal = await document(root, id);
      await assert.rejects(syncLinearIssues({ team: "LIT", limit: 1, atomic, forwardOnly: true }, root, { fetchIssues: async () => [state.issue] }), refused(unsupported));
      await assert.rejects(previewLinearOwnership({ item: id }, root), refused(unsupported));
      assert.deepEqual(await document(root, id), beforeRefusal);
    }
    state.issue.description = bodies[Math.floor(random() * bodies.length)];
    state.issue.assignee = { name: assignees[Math.floor(random() * assignees.length)], email: null };
    state.issue.priority = Math.floor(random() * 5);
    state.issue.labels = { nodes: [{ name: `sequence-${sequence}` }, { name: ["none", "null", "-", "@file", "--", "a,b"][sequence % 6] }], pageInfo: { hasNextPage: false } } as LinearIssue["labels"];
    const before = await document(root, id);
    const plan = buildItemPlan(state.issue, {});
    const result = await syncLinearIssues({ team: "LIT", limit: 1, atomic, forwardOnly: true }, root, { fetchIssues: async () => [state.issue] });
    assert.equal(result.updated, 1, `import ${sequence}`); assert.equal(result.skipped, 0);
    const after = await document(root, id);
    assert.equal(after.body, state.issue.description, `literal body ${sequence}`);
    assert.equal(after.metadata.title, plan.title, `literal title ${sequence}`);
    assert.equal(after.metadata.assignee, plan.assignee ?? before.metadata.assignee, `literal assignee ${sequence}`);
    const expected = canonicalDocument({ metadata: { ...before.metadata, ...plan } as ItemMetadata, body: plan.body }, { schema: (await readSettings(root)).schema });
    assert.deepEqual(after.metadata.tags, expected.metadata.tags);
    for (const field of ["parent", "goal", "objective", "sprint", "release"] as const) assert.equal(after.metadata[field], relationships[field]);
    const base = history.length ? history[Math.floor(random() * history.length)] : undefined;
    const report = await previewLinearOwnership({ item: id, base }, root);
    assert.equal(report.counts.conflicts, 0, `preview ${sequence}`);
    assert.ok(report.observation.fields.every((field) => field.local === field.provider), `stored projection ${sequence}`);
    if (base) assert.ok(report.fields.every((field) => field.decision === "unchanged" || field.decision === "aligned"));
    history.push(report.observation);
  }
});


test("literal class: projection reads real SDK lifecycle effects instead of hashing raw option values", async (t) => {
  const { root, state, id } = await fixture(t);
  state.issue.title = " Surrounded native title ";
  const statusMap = { Queue: "canceled" };
  const savedPush = process.env.LINEAR_PUSH_ON_WRITE;
  process.env.LINEAR_PUSH_ON_WRITE = "1";
  t.after(() => { if (savedPush === undefined) delete process.env.LINEAR_PUSH_ON_WRITE; else process.env.LINEAR_PUSH_ON_WRITE = savedPush; });
  const before = await document(root, id);
  const requests = state.requests;
  const first = await previewLinearOwnership({ item: id, statusMap }, root);
  assert.equal(state.requests - requests, 2, "staged SDK writes never run provider hooks");
  assert.deepEqual(await document(root, id), before);
  await syncLinearIssues({ team: "LIT", limit: 1, atomic: true, forwardOnly: true, statusMap }, root, { fetchIssues: async () => [state.issue] });
  const stored = await document(root, id);
  assert.equal(stored.metadata.assignee, undefined);
  const after = await previewLinearOwnership({ item: id, statusMap }, root);
  assert.ok(after.observation.fields.every((field) => field.local === field.provider));
  assert.notEqual(first.observation.fields.find((field) => field.field === "assignee")?.local, first.observation.fields.find((field) => field.field === "assignee")?.provider);
});
