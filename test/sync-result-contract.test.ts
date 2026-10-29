/** Public fetched-payload contracts and optional assignment effects use real non-git SDK trackers. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import http from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { syncLinearIssues, importLinearAtomic, parseProvenance, type LinearIssue, type SyncResult } from "../index.ts";

const team = { id: "contract-team", key: "ENG", issueEstimationType: "fibonacci", issueEstimationAllowZero: true, issueEstimationExtended: false };
/** Every selected provider field deliberately retains raw whitespace, casing and CRLF. */
function provider(id: string, scaled: boolean): LinearIssue {
  return { id: `contract-${id}`, identifier: `ENG-${id}`, title: ` Raw ${id} `, description: ` Raw corpus sentinel ${id}\r\n detail `,
    priority: 2, estimate: 5, ...(scaled ? { team: { ...team } } : {}), state: { name: "Queue", type: "unstarted" },
    labels: { nodes: [{ name: " Bug " }, { name: "constructor" }] }, dueDate: "2026-12-01", cycle: { name: " Sprint " },
    assignee: { name: "Provider Agent", email: "provider@example.invalid" }, project: { name: " Project " }, customer: { name: " Customer " }, url: `https://linear.app/issue/ENG-${id}` };
}
/** Keep source state outside git and expose no git executable to any tested import path. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "linear-contract-"));
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" }); await pm.init("contract");
  const previous = { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES };
  process.env.PATH = root; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(async () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(root, { recursive: true, force: true }); });
  return { root, pm };
}

test("sync fetched issue contract survives every mode, filter, replay and failed target", async (t) => {
  const { root, pm } = await fixture(t);
  for (const scaled of [false, true]) {
    const fetched = [provider("c", scaled), provider("a", scaled), provider("b", scaled)];
    for (const atomic of [false, true]) for (const mode of ["apply", "replay", "dry", "filtered", "failed"] as const) {
      if (mode !== "replay") for (const issue of fetched) issue.title = ` ${atomic} ${mode} ${issue.id}\r\n `;
      const before = structuredClone(fetched), state = (await pm.listAllComplete({ includeBody: true })).items;
      const result = await syncLinearIssues({ team: "ENG", limit: 10, atomic, dryRun: mode === "dry", ...(mode === "filtered" ? { stateFilter: "missing" } : {}) }, root, {
        fetchIssues: async () => fetched,
        onEstimateBoundary: async (stage, id) => { if (mode === "failed" && stage === "before_update" && id.endsWith("eng-b")) throw new Error("Native target refused"); },
      });
      assert.deepEqual(result.issues, before, `${scaled}/${atomic}/${mode}: full fetched payload in provider order`);
      assert.deepEqual(fetched, before, "mapping never mutates the fetched provider records");
      if (mode === "dry" || mode === "filtered" || mode === "replay") assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, state);
      if (mode === "failed") assert.equal(result.skipped, 1);
      if (mode === "filtered") assert.equal(result.skipped, 3);
      if (mode === "apply") assert.ok(result.synced > 0);
    }
    // A deterministic 500-record corpus proves local filters do not redefine fetched membership.
    let seed = 62026;
    const generated = Array.from({ length: 500 }, (_, index) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const issue = provider(`generated-${index}`, scaled); issue.priority = seed % 5; issue.estimate = [null, 0, 1, 3.5, 5, 8][seed % 6];
      issue.description = seed % 2 ? " Whitespace\r\nvariant " : " Whitespace\nvariant "; return issue;
    });
    for (const atomic of [false, true]) for (const dryRun of [false, true]) {
      const result = await syncLinearIssues({ team: "ENG", limit: 500, atomic, dryRun, stateFilter: "missing" }, root, { fetchIssues: async () => generated });
      assert.deepEqual(result.issues, generated); assert.equal(result.skipped, 500); assert.equal(result.synced, 0);
    }
    const empty = await syncLinearIssues({ team: "ENG", limit: 1 }, root, { fetchIssues: async () => [] }); assert.deepEqual(empty.issues, []);
    const receipt = await importLinearAtomic(root, "ENG", []); assert.equal(Object.hasOwn(receipt, "issues"), false, "prepared-row receipts never fabricate provider payloads");
  }
});

test("assignment clearing and compact receipts agree across payload families, SDK and every CLI renderer", async (t) => {
  const { root, pm } = await fixture(t);
  const reference = await pm.create({ title: "Native unset reference", assignee: "Local Agent", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  await pm.update(reference.item.id, { parent: "none", unset: ["assignee", "goal", "objective", "sprint", "release"] });
  const cleared = (await pm.get(reference.item.id, { depth: "deep" })).item.assignee;
  const wire = { issue: provider("assignment", false) };
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (chunk: Buffer) => { raw += chunk.toString(); }); req.on("end", () => {
      const { query } = JSON.parse(raw) as { query: string }; assert.ok(!query.trimStart().startsWith("mutation"));
      const pageInfo = { hasNextPage: false, endCursor: null };
      const data = query.includes("LinearSchema") ? { teams: { nodes: [{ ...team, cyclesEnabled: false, triageEnabled: false, defaultIssueState: null, states: { nodes: [{ id: "queue", ...wire.issue.state }], pageInfo } }] }, issueLabels: { nodes: [], pageInfo } }
        : query.includes("viewer") ? { viewer: { id: "reader" } } : { issues: { nodes: [wire.issue], pageInfo } };
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); const address = server.address(); assert.ok(address && typeof address !== "string");
  const saved = { LINEAR_API_KEY: process.env.LINEAR_API_KEY, LINEAR_API_BASE_URL: process.env.LINEAR_API_BASE_URL };
  process.env.LINEAR_API_KEY = "synthetic-key"; process.env.LINEAR_API_BASE_URL = `http://127.0.0.1:${address.port}/graphql`;
  t.after(async () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await new Promise<void>((done) => server.close(() => done())); });
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  for (const scaled of [false, true]) for (const atomic of [false, true]) for (const route of ["sdk", "sync", "linear", "linear-sync"]) for (const json of route === "sdk" ? [true] : [true, false]) {
    wire.issue = provider("assignment", scaled);
    await syncLinearIssues({ team: "ENG", limit: 1 }, root, { fetchIssues: async () => [wire.issue] });
    const id = (await pm.listAllComplete()).items.find((item) => parseProvenance(item.description)?.linear_id === wire.issue.id)!.id;
    await pm.update(id, { assignee: "Local Agent", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
    const ignored = route === "linear-sync" || route === "sdk" && atomic;
    if (!ignored) { if (route === "sync") wire.issue.assignee = null; else if (route === "linear") wire.issue.assignee = { name: null, email: null }; else delete wire.issue.assignee; }
    if (route === "sdk") {
      const result = await syncLinearIssues({ team: "ENG", limit: 1, atomic, ...(ignored ? { fieldMap: { assignee: "ignore" } } : {}) }, root, { fetchIssues: async () => [wire.issue] });
      assert.deepEqual(result.issues, [wire.issue]);
    } else {
      const options = { team: "ENG", atomic, skipPreflightNetwork: true, ...(ignored ? { map: "assignee=ignore" } : {}) };
      const output = route === "sync" ? await harness.runCommand({ command: "linear sync", pmRoot: root, options, global: { json } }) : await harness.runImporter({ importer: route, pmRoot: root, options, global: { json } });
      assert.equal(output.exitCode ?? 0, 0); assert.equal(Object.hasOwn(output.result as object, "issues"), false, "CLI receipts omit fetched payloads");
      assert.ok((output.result as SyncResult).importResults?.length);
    }
    assert.deepEqual((await pm.get(id, { depth: "deep" })).item.assignee, cleared, `${scaled}/${atomic}/${route}/${json}: SDK unset effect`);
  }
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /Omitted optional assignments retain|local value for legacy payloads/);
  assert.match(readme, /Every payload family clears absent mapped/);
});
