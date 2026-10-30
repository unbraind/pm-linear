/** Adversarial import boundaries use native SDK writes in plain trackers, with no SDK mocks. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, getHistoryPath, locateItem, PmClient, readHistoryEntries } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildItemPlan, importLinearAtomic, importLinearForwardOnly, LinearAtomicRefusal, parseProvenance, syncLinearIssues,
  type LinearIssue, type LinearImportReceipt, type PreparedLinearImport } from "../index.ts";

/** Include prototype-shaped provider IDs and both supported payload families. */
function provider(id: string, scaled = false): LinearIssue {
  return { id, identifier: `ENG-${id}`, title: "Original", description: "Original body", priority: 2, dueDate: null,
    state: { name: "Queue", type: "unstarted" }, labels: { nodes: [] }, ...(scaled ? { team } : {}) };
}
const team = { id: "boundary-team", key: "ENG", issueEstimationType: "fibonacci", issueEstimationAllowZero: true, issueEstimationExtended: false };
/** Render prepared rows with the same exported builder used by provider imports. */
function prepared(issue: LinearIssue): PreparedLinearImport {
  return { ...buildItemPlan(issue, {}), linearId: issue.id, identifier: issue.identifier };
}
/** Plain tracker, local provider and restored environment; neither git nor pm is available on PATH. */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "linear-boundaries-"));
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" }); await pm.init("boundaries");
  const wire = { issues: [provider("source")] };
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (chunk: Buffer) => { raw += chunk.toString(); }); req.on("end", () => {
      const { query } = JSON.parse(raw) as { query: string }; assert.ok(!query.trimStart().startsWith("mutation"));
      const pageInfo = { hasNextPage: false, endCursor: null };
      const data = query.includes("LinearSchema") ? { teams: { nodes: [{ ...team, cyclesEnabled: false, triageEnabled: false, defaultIssueState: null,
        states: { nodes: [{ id: "queue", name: "Queue", type: "unstarted" }, { id: "done", name: "Done", type: "completed" }], pageInfo } }] }, issueLabels: { nodes: [], pageInfo } }
        : query.includes("viewer") ? { viewer: { id: "reader" } } : { issues: { nodes: wire.issues, pageInfo } };
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); const address = server.address(); assert.ok(address && typeof address !== "string");
  const changes = { PATH: root, GIT_CEILING_DIRECTORIES: tmpdir(), LINEAR_API_KEY: "synthetic-key", LINEAR_API_BASE_URL: `http://127.0.0.1:${address.port}/graphql` };
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]])); Object.assign(process.env, changes);
  t.after(async () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>((done) => server.close(() => done())); await fs.rm(root, { recursive: true, force: true }); });
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  /** Exercise actual registered handlers and host exit-code interpretation. */
  async function cli(route: string, options: Record<string, unknown>, json: boolean) {
    return route === "sync" ? harness.runCommand({ command: "linear sync", pmRoot: root, options, global: { json } })
      : harness.runImporter({ importer: route, pmRoot: root, options, global: { json } });
  }
  return { root, pm, wire, cli };
}

const routes = ["sdk", "prepared", "compatibility", "sync", "linear", "linear-sync"];

test("identity class: generated non-unique provenance never selects or creates a native target on any route", async (t) => {
  const { root, pm, wire, cli } = await fixture(t);
  for (const scaled of [false, true]) for (const key of ["ordinary", "constructor", "__proto__"]) {
    const issue = provider(`${key}-${scaled}`, scaled); wire.issues = [issue];
    const row = prepared(issue), ids: string[] = [];
    for (let duplicate = 0; duplicate < 2 + key.length % 3; duplicate++) {
      const result = await pm.create({ title: `Duplicate ${duplicate}`, description: row.description, parent: "none", unset: ["goal", "objective", "sprint", "release"] }); ids.push(result.item.id);
    }
    const before = (await pm.listAllComplete({ includeBody: true })).items;
    const histories = await Promise.all(ids.map((id) => readHistoryEntries(getHistoryPath(root, id), id)));
    for (const route of routes) for (const dryRun of route === "prepared" || route === "compatibility" ? [false] : [false, true]) {
      let receipt: LinearImportReceipt;
      if (route === "sdk") receipt = await syncLinearIssues({ team: "ENG", limit: 10, dryRun }, root, { fetchIssues: async () => [issue] });
      else if (route === "prepared" || route === "compatibility") {
        const run = route === "prepared" ? importLinearForwardOnly : importLinearAtomic;
        for (const explicit of [false, true]) {
          const result = await run(root, "ENG", [{ ...row, ...(explicit ? { match: before.find((item) => item.id === ids[0]) } : {}) }], { forwardOnly: true });
          assert.equal(result.created, 0); assert.equal(result.itemIds.has(row.identifier), false);
        }
        receipt = await run(root, "ENG", [row], { forwardOnly: true });
      } else {
        // forward-only dry-run fetches and simulates the exact write path.
        for (const json of [false, true]) {
          const output = await cli(route, { team: "ENG", atomic: true, forwardOnly: true, dryRun, skipPreflightNetwork: true }, json);
          assert.equal(output.exitCode, 1, `${route}/${json}: conflict process status`);
          receipt = output.result as LinearImportReceipt;
          assert.equal(receipt.success, false); assert.equal(receipt.importResults?.[0].code, "import_conflict");
        }
        receipt = (await cli(route, { team: "ENG", atomic: true, forwardOnly: true, dryRun, skipPreflightNetwork: true }, true)).result as LinearImportReceipt;
      }
      assert.equal(receipt.exit_code, 1, route); assert.equal(receipt.skipped, 1); assert.equal("imported" in receipt ? receipt.imported : receipt.synced, 0);
      assert.deepEqual(receipt.importResults?.map((entry) => [entry.id, entry.action, entry.code]), [[null, "skipped", "import_conflict"]]);
      assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, before, `${route}: no third link or changed peer`);
      assert.deepEqual(await Promise.all(ids.map((id) => readHistoryEntries(getHistoryPath(root, id), id))), histories);
    }
  }
});

test("identity class: duplicate provider identities with different unused deterministic IDs refuse every row", async (t) => {
  const { root, pm, wire, cli } = await fixture(t);
  for (const route of routes) {
    const issue = provider(`duplicate-${route}`), other = { ...issue, identifier: `ENG-other-${route}` }; wire.issues = [issue, other];
    const before = (await pm.listAllComplete({ includeBody: true })).items;
    const receipt = route === "sdk" ? await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => wire.issues })
      : route === "prepared" || route === "compatibility" ? await (route === "prepared" ? importLinearForwardOnly : importLinearAtomic)(root, "ENG", wire.issues.map(prepared), { forwardOnly: true })
      : (await cli(route, { team: "ENG", skipPreflightNetwork: true }, true)).result as LinearImportReceipt;
    assert.equal(receipt.exit_code, 1); assert.equal(receipt.created, 0); assert.equal(receipt.skipped, 2);
    assert.deepEqual(receipt.importResults?.map((row) => [row.code, row.id, row.linearId]), [["import_conflict", null, issue.id], ["import_conflict", null, issue.id]]);
    assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, before);
  }
});

test("atomic class: every explicit stronger-guarantee request refuses before even reading an unusable tracker", async (t) => {
  const { root, pm, wire, cli } = await fixture(t);
  const before = (await pm.listAllComplete({ includeBody: true })).items;
  for (const dryRun of [false, true]) for (const forwardOnly of [undefined, false]) for (const tracker of [root, join(root, "missing")]) {
    let fetched = 0;
    await assert.rejects(syncLinearIssues({ team: "ENG", limit: 10, atomic: true, forwardOnly, dryRun }, tracker, { fetchIssues: async () => { fetched++; return wire.issues; } }), LinearAtomicRefusal);
    await assert.rejects(importLinearAtomic(tracker, "ENG", wire.issues.map(prepared), { forwardOnly }), LinearAtomicRefusal);
    assert.equal(fetched, 0);
    for (const route of ["sync", "linear", "linear-sync"]) for (const json of [false, true]) {
      const output = await cli(route, { team: "ENG", atomic: true, forwardOnly, dryRun, skipPreflightNetwork: true }, json);
      assert.equal(output.exitCode, 2); assert.equal((output.result as { code: string }).code, "atomic_unavailable");
      assert.match((output.result as { remedy: string }).remedy, /forward-only/);
    }
  }
  assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, before);
  const migrated = await importLinearAtomic(root, "ENG", wire.issues.map(prepared), { forwardOnly: true });
  assert.equal(migrated.created, 1); assert.equal(migrated.atomic, false); assert.equal(migrated.exit_code ?? 0, 0);
  const legacyDefault = await syncLinearIssues({ team: "ENG", limit: 1 }, root, { fetchIssues: async () => wire.issues }); assert.equal(legacyDefault.exit_code ?? 0, 0);
});

test("outcome class: failed, conflicted and partially saved rows exit nonzero on all routes and renderers; filters and reconciled writes succeed", async (t) => {
  const { root, pm, wire, cli } = await fixture(t);
  for (const scaled of [false, true]) for (const route of routes) for (const json of route === "sdk" || route === "prepared" || route === "compatibility" ? [true] : [false, true]) {
    const issue = provider(`outcome-${route}-${json}-${scaled}`, scaled); wire.issues = [issue];
    const seeded = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [issue] }); const id = seeded.importResults![0].id!;
    /** Run the selected public route without replacing the native SDK. */
    async function run(extra: Record<string, unknown> = {}) {
      if (route === "sdk") return syncLinearIssues({ team: "ENG", limit: 10, ...extra }, root, { fetchIssues: async () => wire.issues });
      if (route === "prepared" || route === "compatibility") return (route === "prepared" ? importLinearForwardOnly : importLinearAtomic)(root, "ENG", wire.issues.map(prepared), { forwardOnly: true });
      const output = await cli(route, { team: "ENG", skipPreflightNetwork: true, ...extra }, json);
      const receipt = output.result as LinearImportReceipt; assert.ok(receipt, JSON.stringify(output)); assert.equal(output.exitCode ?? 0, receipt.exit_code ?? 0); return receipt;
    }
    const release = await acquireLock(root, id, 60, "peer"); issue.title = "Conflicted";
    try { const receipt = await run(); assert.equal(receipt.exit_code, 1); assert.equal(receipt.success, false); assert.equal(receipt.importResults?.[0].code, "import_conflict"); }
    finally { await release(); }
    const located = await locateItem(root, id); assert.ok(located);
    // Fault only the live item's atomic rename. The real SDK writes fields and
    // history first; its second save (close) fails. Preview copies are unaffected.
    const rename = fs.rename; let faults = 0; let faultMode = "before";
    fs.rename = async (from, to) => {
      if (String(to) === located.itemPath && (faultMode === "before" || /status: closed/.test(await fs.readFile(from, "utf8")))) {
        faults++;
        if (faultMode === "after") await rename(from, to);
        throw Object.assign(new Error("Injected native IO failure"), { code: "EIO" });
      }
      return rename(from, to);
    }; syncBuiltinESMExports();
    try {
      const failed = await run(); assert.equal(failed.exit_code, 1); assert.equal(failed.importResults?.[0].code, "import_failed");
      assert.equal(failed.unconfirmed, 0); assert.equal((await pm.get(id)).item.title, `[${issue.identifier}] Original`);
      faultMode = "partial"; faults = 0;
      issue.title = "Partially saved"; issue.state = { name: "Done", type: "completed" };
      const receipt = await run(); assert.ok(faults > 0, "fault must occur after real pre-update persistence");
      assert.equal(receipt.exit_code, 1); assert.equal(receipt.success, false); assert.equal(receipt.unconfirmed, 1);
      assert.equal(receipt.importResults?.[0].action, "unconfirmed"); assert.equal(receipt.importResults?.[0].code, "import_incomplete");
      const item = (await pm.get(id)).item; assert.equal(item.title, `[${issue.identifier}] Partially saved`); assert.equal(item.status, "open");
      assert.ok((await readHistoryEntries(getHistoryPath(root, id), id)).some((row) => row.op === "update"), "partial audit retained");
      faultMode = "after";
      const reconciled = await run(); assert.equal(reconciled.exit_code ?? 0, 0); assert.equal(reconciled.unconfirmed, 0);
      assert.equal(reconciled.importResults?.[0].code, "import_reconciled"); assert.equal("imported" in reconciled ? reconciled.imported : reconciled.synced, 0);
    } finally { fs.rename = rename; syncBuiltinESMExports(); }
    const retry = await run(); assert.equal(retry.exit_code ?? 0, 0); assert.equal(retry.unconfirmed, 0); assert.equal((await pm.get(id)).item.status, "closed");
    const unchanged = await run(); assert.equal(unchanged.exit_code ?? 0, 0); assert.equal("imported" in unchanged ? unchanged.imported : unchanged.synced, 0);
    assert.equal(parseProvenance((await pm.get(id)).item.description)?.linear_id, issue.id);
    if (route !== "prepared" && route !== "compatibility") { const filtered = await run({ state: "missing", stateFilter: "missing" }); assert.equal(filtered.exit_code ?? 0, 0); assert.equal(filtered.skipped, 1); }
  }
});


test("outcome observer class: applied writes retain their receipts but observer failures still report nonzero status", async (t) => {
  const { root, pm } = await fixture(t);
  for (const route of ["sdk", "prepared", "compatibility"]) {
    const issue = provider(`observer-${route}`);
    const boundary = async (stage: string) => { if (stage === "after_write") throw new Error("Observer failed after native success"); };
    const result = route === "sdk" ? await syncLinearIssues({ team: "ENG", limit: 1 }, root, { fetchIssues: async () => [issue], onEstimateBoundary: boundary })
      : await (route === "prepared" ? importLinearForwardOnly : importLinearAtomic)(root, "ENG", [prepared(issue)], { forwardOnly: true, onBoundary: boundary });
    assert.equal(result.created, 1); assert.equal(result.success, false); assert.equal(result.exit_code, 1);
    assert.equal(result.importResults?.[0].action, "created"); assert.equal(result.importResults?.[0].code, "import_observer_failed");
    assert.equal((await pm.get(result.importResults![0].id!)).item.title, `[${issue.identifier}] Original`);
  }
});
