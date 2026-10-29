/** Unit provenance, real SDK persistence, replay and revision interleavings in non-git trackers. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { PmClient, readSettings, normalizeItemId, getHistoryPath, readHistoryEntries, parseTags, toNonEmptyImportString } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { encodeLinearEstimate, readLinearEstimate, linearEstimateScaleRevision, inspectLinearEstimates, syncLinearIssues, buildItemPlan, itemToLinearPayload, buildProvenance, deriveAtomicItemId, LinearEstimateRefusal,
  type LinearEstimateTeam, type LinearEstimateMapping, type LinearEstimateReport, type LinearIssue, type SyncResult } from "../index.ts";

const team: LinearEstimateTeam = { id: "team-a", key: "ENG", issueEstimationType: "fibonacci", issueEstimationAllowZero: false, issueEstimationExtended: false };
const mapping: LinearEstimateMapping = { teamId: team.id, scaleRevision: linearEstimateScaleRevision(team), entries: [{ points: 5, minutes: 240 }, { points: 0, minutes: 0 }] };
/** Fully selected issue including native values and whitespace variants. */
function issue(id = "remote-a"): LinearIssue {
  return { id, identifier: `ENG-${id.replaceAll("_", "-")}`, title: " Work ", description: " Body\r\ntext ", priority: 2, estimate: 5, team: { ...team },
    state: { name: "Queue", type: "unstarted" }, labels: { nodes: [{ name: "bug" }], pageInfo: { hasNextPage: false } } as LinearIssue["labels"],
    dueDate: "2026-12-01", assignee: { email: "agent@example.invalid", name: "Agent" }, cycle: { name: "Cycle" }, project: { name: "Project" }, customer: { name: "Customer" }, url: "https://linear.app/issue/ENG-1" };
}
/** Plain SDK tracker with no enclosing git discovery or extension hooks. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "linear-units-"));
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" });
  await pm.init("units");
  const previous = { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES };
  process.env.PATH = root; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(async () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(root, { recursive: true, force: true }); });
  return { root, pm };
}
/** Match only typed sanitized refusals with an actionable remedy. */
function refusal(code = "estimate_input_invalid") {
  return (error: unknown) => { assert.ok(error instanceof LinearEstimateRefusal); assert.equal(error.code, code); assert.ok(error.remedy.length > 20); return true; };
}
/** Exercise the same import engine as every command/import alias. */
async function sync(root: string, value: LinearIssue, atomic = false, conversion?: LinearEstimateMapping, onEstimateBoundary?: (stage: string, id: string) => Promise<void>) {
  return syncLinearIssues({ team: value.team?.key ?? "ENG", limit: 10, atomic, estimateMapping: conversion }, root,
    { fetchIssues: async () => [structuredClone(value)], onEstimateBoundary });
}

test("five points stay points; declared discrete mappings convert, stale scales invalidate only their team", async (t) => {
  const { root, pm } = await fixture(t);
  await sync(root, issue());
  let report = await inspectLinearEstimates({ team }, root);
  assert.equal(report.rows[0].points, 5); assert.equal(report.rows[0].minutes, null);
  const first = (await pm.get(report.rows[0].id, { depth: "deep" })).item;
  assert.equal(first.estimated_minutes, undefined);
  assert.equal(itemToLinearPayload(first).estimate, 5);
  assert.ok(!itemToLinearPayload(first).labels!.some((label) => label.startsWith("linear-estimate:")));
  await sync(root, issue(), true, mapping);
  report = await inspectLinearEstimates({ team }, root);
  assert.equal(report.rows[0].minutes, 240);
  const other = issue("remote-b"); other.team = { ...team, id: "team-b", key: "OPS" }; other.identifier = "OPS-1";
  await sync(root, other, true);
  const changed = { ...team, issueEstimationExtended: true };
  const stale = await inspectLinearEstimates({ team: changed }, root);
  assert.equal(stale.counts.invalidated, 1); assert.equal(stale.counts.foreign, 1); assert.equal(stale.rows[0].state, "scale_changed"); assert.equal(stale.rows[0].minutes, null);
  assert.equal((await inspectLinearEstimates({ team: other.team }, root)).counts.invalidated, 0);
  const newer = issue(); newer.team = changed;
  await sync(root, newer);
  assert.equal((await inspectLinearEstimates({ team: changed }, root)).rows[0].state, "mapping_stale");
  await assert.rejects(sync(root, newer, true, mapping), refusal("estimate_scope_mismatch"));
  const zero = issue("zero"); zero.estimate = 0;
  await sync(root, zero, false, mapping);
  assert.equal((await inspectLinearEstimates({ team }, root)).rows.find((row) => row.points === 0)?.minutes, 0);
  const missing = issue("missing"); missing.estimate = null;
  await sync(root, missing);
  assert.ok((await inspectLinearEstimates({ team }, root)).rows.some((row) => row.points === null && row.minutes === null));
});

test("one strict schema bounds input/output, producers round-trip, and malformed records fail alone", async (t) => {
  const { root, pm } = await fixture(t);
  for (const invalid of [null, 42, [], {}, { ...team, issueEstimationAllowZero: "false" }]) assert.throws(() => encodeLinearEstimate(invalid as unknown as LinearEstimateTeam, 5), refusal());
  assert.equal(readLinearEstimate(null as unknown as string[]).reason, "invalid");
  for (const points of [NaN, Infinity, -Infinity, -1, 1000001, Number.MAX_VALUE]) assert.throws(() => encodeLinearEstimate(team, points), refusal());
  for (const minutes of [NaN, Infinity, -1, 0.5, 175201, Number.MAX_VALUE]) assert.throws(() => encodeLinearEstimate(team, 5, { ...mapping, entries: [{ points: 5, minutes }] }), refusal());
  for (const extra of [{ unknown: true }, { entries: new Array(1) }, { entries: Array.from({ length: 65 }, () => ({ points: 5, minutes: 1 })) }, { entries: [{ points: 5, minutes: 1 }, { points: 5, minutes: 2 }] }]) assert.throws(() => encodeLinearEstimate(team, 5, { ...mapping, ...extra }), refusal());
  assert.throws(() => encodeLinearEstimate(team, 5, { ...mapping, teamId: "other" }), refusal("estimate_scope_mismatch"));
  for (let index = 0; index < 500; index++) {
    const points = index % 3 ? index / 2 : null;
    const encoded = encodeLinearEstimate({ ...team, issueEstimationType: index % 2 ? "future-scale" : "fibonacci" }, points);
    const read = readLinearEstimate([encoded]); assert.ok(read.contract);
    assert.equal(read.contract.points, points);
    assert.equal(read.contract.team.issueEstimationType, index % 2 ? "future-scale" : "fibonacci");
    assert.equal(encodeLinearEstimate(read.contract.team, read.contract.points, read.contract.mapping), encoded);
  }
  for (const points of [0, Number.MIN_VALUE, 1000000]) {
    const encoded = encodeLinearEstimate(team, points, { ...mapping, entries: [{ points, minutes: 175200 }] });
    assert.equal(readLinearEstimate([encoded]).contract?.points, points);
    assert.equal(readLinearEstimate([encoded]).contract?.mapping?.entries[0].minutes, 175200);
  }
  assert.equal(readLinearEstimate([]).reason, "missing");
  const good = encodeLinearEstimate(team, 5, mapping);
  assert.equal(readLinearEstimate([good, good]).reason, "ambiguous");
  for (const token of ["!", "a".repeat(16385), Buffer.from("{}").toString("hex"), "null", Buffer.from(JSON.stringify({ ...readLinearEstimate([good]).contract!, scaleRevision: "0".repeat(64) })).toString("hex")]) assert.equal(readLinearEstimate([`linear-estimate:${token}`]).reason, "invalid");
  for (const limit of [NaN, Infinity, -1, 0, 0.5, 101]) await assert.rejects(inspectLinearEstimates({ team, limit }, root), refusal());
  await sync(root, issue());
  await pm.create({ title: "Legacy", tags: '["estimate:5"]', parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  await pm.create({ title: "Foreign", tags: JSON.stringify([good]), parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  await pm.create({ title: "Broken", tags: '["linear-estimate:!"]', parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  const result = await inspectLinearEstimates({ team, limit: 1 }, root);
  assert.equal(result.counts.invalid, 2); assert.equal(result.counts.legacy, 1); assert.equal(result.counts.matched, 1); assert.ok(JSON.stringify(result).length < 1500);
  const ignored = buildItemPlan(issue(), {}, { estimate: "ignore" }); assert.ok(!ignored.tags.some((tag) => tag.startsWith("estimate:") || tag.startsWith("linear-estimate:")));
  const forged = issue(); forged.labels.nodes.push({ name: good }); assert.equal(buildItemPlan(forged, {}).tags.filter((tag) => tag.startsWith("linear-estimate:")).length, 1);
  assert.ok(itemToLinearPayload(buildItemPlan(forged, {})).labels!.includes(good));
  for (const label of ["linear-estimate:legacy", "linear-native-label:!", "linear-native-label:ff", "linear-native-label:", `linear-native-label:${Buffer.from("estimate:9").toString("hex")}`, `linear-native-label:${Buffer.from(JSON.stringify({ format: "foreign", label: "estimate:9" })).toString("hex")}`]) assert.ok(itemToLinearPayload({ tags: [label] }).labels!.includes(label));
});

test("CLI JSON and TOON share the SDK verdict; strict guards and offline files precede provider reads", async (t) => {
  const { root } = await fixture(t);
  await sync(root, issue(), false, mapping);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  const scale = join(root, "scale.json"); await writeFile(scale, JSON.stringify(team));
  const expected = await inspectLinearEstimates({ team }, root);
  for (const global of [{ json: true }, {}]) {
    const result = await harness.runCommand({ command: "linear estimates", pmRoot: root, options: { team: " eng ", scale }, global });
    assert.deepEqual(result.result, expected);
  }
  for (const options of [{}, { team: true }, { team: "ENG", scale: true }, { team: "ENG", scale, limit: true }, { team: "ENG", scale, limit: "Infinity" }, { team: "ENG", scale, limit: "" }, { team: "ENG", scale, limit: "0" }, { team: "OPS", scale }, { team: "ENG", scale: "missing.json" }]) {
    const result = await harness.runCommand({ command: "linear estimates", pmRoot: root, options, global: { json: true } });
    assert.equal(result.exitCode, 2); assert.match((result.result as { code: string }).code, /^estimate_/);
  }
  for (const contents of ["broken", " ".repeat(16385), "{}"]) {
    await writeFile(scale, contents);
    assert.equal((await harness.runCommand({ command: "linear estimates", pmRoot: root, options: { team: "ENG", scale }, global: {} })).exitCode, 2);
  }
});

test("revision checks refuse peer transitions and ABA at every import boundary on one tracker", async (t) => {
  const { root, pm } = await fixture(t);
  for (const atomic of [false, true]) for (const boundary of ["observed", "inspect", ...(atomic ? ["compensation_prepared"] : []), "before_write", "written", "after_write"]) {
    const value = issue(`${atomic}-${boundary}`);
    await sync(root, value, atomic);
    // Resolve through provider identity instead of assuming item ID punctuation normalization.
    const selected = (await pm.listAllComplete({ includeBody: true })).items.find((row) => row.description?.includes(value.id)); assert.ok(selected);
    const target = selected.id;
    let injected = false;
    value.title = "Provider changed";
    const result = await sync(root, value, atomic, undefined, async (stage, current) => {
      if (stage !== boundary || injected) return;
      assert.equal(current, target); injected = true;
      await pm.update(target, { title: "Peer owns this revision" });
      if (stage !== "after_write" && stage !== "written") { await pm.update(target, { title: selected.title }); }
    });
    assert.equal(injected, true, boundary);
    const read = (await pm.get(target, { depth: "deep" })).item;
    if (boundary === "after_write" || boundary === "written") assert.equal(read.title, "Peer owns this revision");
    else { assert.equal(read.title, selected.title); assert.equal(result.skipped, 1); }
  }
});

/** Deterministic PRNG keeps 500 generated state-machine sequences reproducible. */
function random(seed: number) { let state = seed; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }; }

test("seed 1620: 500 model-based import/export/sync sequences read state back through SDK", { timeout: 900000 }, async (t) => {
  const container = await fixture(t);
  const originalError = console.error; console.error = () => {};
  t.after(() => { console.error = originalError; });
  const rng = random(1620);
  const wire = { current: issue(), statuses: [] as Array<{ id: string; name: string; type: string }> };
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (chunk: Buffer) => { raw += chunk.toString(); }); req.on("end", () => {
      const { query } = JSON.parse(raw) as { query: string }; assert.ok(!query.trimStart().startsWith("mutation"));
      const pageInfo = { hasNextPage: false, endCursor: null };
      const data = query.includes("LinearSchema") ? {
        teams: { nodes: [{ ...team, cyclesEnabled: false, triageEnabled: false, defaultIssueState: null, states: { nodes: wire.statuses, pageInfo } }] },
        issueLabels: { nodes: [], pageInfo },
      } : { issues: { nodes: [wire.current], pageInfo } };
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const saved = { LINEAR_API_KEY: process.env.LINEAR_API_KEY, LINEAR_API_BASE_URL: process.env.LINEAR_API_BASE_URL };
  process.env.LINEAR_API_KEY = "synthetic-key"; process.env.LINEAR_API_BASE_URL = `http://127.0.0.1:${address.port}/graphql`;
  t.after(async () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await new Promise<void>((done) => server.close(() => done())); });
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  const conversionFile = join(container.root, "conversion.json"); await writeFile(conversionFile, JSON.stringify(mapping));
  const routes = ["sdk", "sync", "linear", "linear-sync"];
  const routeCounts = new Map<string, number>();
  for (let group = 0; group < 10; group++) {
    const actualRoot = join(container.root, `actual-${group}`);
    await mkdir(actualRoot, { recursive: true });
    const actual = { root: actualRoot, pm: new PmClient({ cwd: actualRoot, pmRoot: actualRoot, noExtensions: true, author: "fixture" }) };
    await actual.pm.init("units");
    const modelRoot = await mkdtemp(join(tmpdir(), "linear-unit-model-"));
    await new PmClient({ cwd: modelRoot, pmRoot: modelRoot, noExtensions: true, author: "fixture" }).init("units");
    const model = new PmClient({ cwd: modelRoot, pmRoot: modelRoot, noExtensions: true, author: process.env.PM_AUTHOR ?? "pm-linear" });
    t.after(() => rm(modelRoot, { recursive: true, force: true }));
    const aParent = await actual.pm.create({ id: "anchor", title: "Scope", type: "Epic", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
    await model.create({ id: "anchor", title: "Scope", type: "Epic", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
    const statusNames: string[] = [];
    const terminalStatuses = new Set<string>();
    const roleChoices = [["active"], ["blocked"], ["terminal", "terminal_done"], ["terminal", "terminal_canceled"]];
    for (let index = 0; index < 5; index++) {
      const name = `custom-${group}-${index}-${(rng() >>> 8) % 100000}`;
      const role = roleChoices[(rng() >>> 8) % roleChoices.length]; statusNames.push(name);
      if (role.includes("terminal")) terminalStatuses.add(name);
      for (const pm of [actual.pm, model]) await pm.schemaAddStatus(name, { role });
    }
    wire.statuses = statusNames.map((name, index) => ({ id: `state-${index}`, name, type: "started" }));
    const settings = await readSettings(actual.root);
    const aId = deriveAtomicItemId("ENG", "ENG-model", settings.id_prefix, normalizeItemId);
    let known = false;
    const history: LinearIssue[] = [];
    for (let local = 0; local < 50; local++) {
      const sequence = group * 50 + local;
      if (sequence % 100 === 0) process.stdout.write(`model sequences: ${sequence}/500\n`);
      const value = issue("model"); value.identifier = "ENG-model";
      value.title = ` ${(rng() >>> 8) % 9} Work ${sequence % 3 ? "" : "\r\n"} `;
      value.description = ` body ${(rng() >>> 8) % 11}${sequence % 2 ? "\r\n" : "\n"} detail `;
      value.estimate = [null, 0, 1, 3.5, 5, 8][(rng() >>> 8) % 6];
      value.priority = (rng() >>> 8) % 5; value.dueDate = (rng() >>> 8) % 2 ? null : "2026-12-01";
      value.assignee = (rng() >>> 8) % 2 ? null : { name: " Native Agent ", email: null };
      value.cycle = { name: ` C${(rng() >>> 8) % 3} ` }; value.customer = { name: ` Customer ${(rng() >>> 8) % 3} ` };
      value.labels.nodes = [{ name: ` tag-${(rng() >>> 8) % 5} ` }, { name: "constructor" }, ...(sequence % 17 === 0 ? [{ name: "estimate:9" }, { name: "cycle:foreign" }] : [])];
      const statusIndex = (rng() >>> 8) % 5; const status = statusNames[statusIndex];
      value.state = { name: status, type: statusIndex % 2 ? "started" : "completed" };
      // Each generated sequence mixes an import/replay, SDK reads and a provider export.
      // Replay values come from inputs actually applied earlier, never an invented normalized oracle.
      const selected = history.length && (rng() >>> 8) % 3 === 0 ? structuredClone(history[(rng() >>> 8) % history.length]) : value;
      for (const remote of sequence % 10 === 0 ? [selected, structuredClone(selected)] : [selected]) {
        history.push(structuredClone(remote));
        const conversion = sequence % 3 ? undefined : mapping;
        const statusMap = Object.fromEntries(statusNames.map((name) => [name, name]));
        // Random ambient focus must never supply relationships to create or update.
        if ((rng() >>> 8) % 2) await actual.pm.focus(aParent.item.id);
        const previous = known ? (await model.get(aId, { depth: "deep" })).item : undefined;
        const atomic = Boolean((rng() >>> 8) % 2);
        const input = { team: "ENG", limit: 10, atomic, statusMap, estimateMapping: conversion };
        const preview = sequence % 25 === 0 ? await syncLinearIssues({ ...input, dryRun: true }, actual.root, { fetchIssues: async () => [remote] }) : undefined;
        wire.current = remote;
        const route = routes[sequence % routes.length]; routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
        let applied: SyncResult;
        if (route === "sdk") applied = await syncLinearIssues(input, actual.root, { fetchIssues: async () => [remote] });
        else {
          const options = { team: "ENG", atomic, skipPreflightNetwork: true, statusMap: statusNames.map((name) => `${name}=${name}`).join(","), ...(conversion ? { estimateMapping: conversionFile } : {}) };
          const dispatched = route === "sync" ? await harness.runCommand({ command: "linear sync", pmRoot: actual.root, options, global: { json: true } }) : await harness.runImporter({ importer: route, pmRoot: actual.root, options, global: { json: true } });
          assert.equal(dispatched.exitCode ?? 0, 0, `model route ${route}`);
          const receipt = dispatched.result as SyncResult & { imported?: number };
          applied = { ...receipt, synced: receipt.synced ?? receipt.imported ?? receipt.created + receipt.updated };
        }
        if (preview) for (const key of ["created", "updated", "skipped", "synced"] as const) assert.equal(preview[key], applied[key], `preview ${sequence} ${key}`);
        const points = remote.estimate ?? null;
        const previousContract = readLinearEstimate(previous?.tags ?? []).contract;
        const tags = [...remote.labels.nodes.map((label) => { const native = parseTags(JSON.stringify([label.name]))[0] ?? ""; return ["linear-estimate:", "linear-native-label:", "estimate:", "cycle:"].some((prefix) => native.startsWith(prefix)) ? `linear-native-label:${Buffer.from(JSON.stringify({ format: "pm-linear/label/1", linearId: remote.id, label: label.name })).toString("hex")}` : label.name; }), `cycle:${toNonEmptyImportString(remote.cycle!.name)}`, ...(points === null ? [] : [`estimate:${points}`]), `customer:${toNonEmptyImportString(remote.customer!.name)}`,
          encodeLinearEstimate(team, points, conversion ?? previousContract?.mapping)];
        const scope = previous?.parent ?? "none";
        const desired = { title: `[${remote.identifier}] ${remote.title}`, body: remote.description ?? "", status: remote.state.name, priority: remote.priority === 0 ? 3 : remote.priority,
          tags: JSON.stringify(tags), description: buildProvenance(remote), parent: scope, unset: ["goal", "objective", "sprint", "release", ...(!remote.dueDate ? ["deadline"] : []), ...(!remote.assignee ? ["assignee"] : [])],
          ...(remote.dueDate ? { deadline: remote.dueDate } : {}), ...(remote.assignee ? { assignee: remote.assignee.name! } : {}),
          ...(terminalStatuses.has(remote.state.name) ? { closeReason: `Linear issue ${remote.identifier} terminal` } : {}) };
        if (known) await model.update(aId, desired); else { await model.create({ ...desired, id: aId }); known = true; }
        const actualItem = (await actual.pm.get(aId, { depth: "deep" })).item;
        const modelItem = (await model.get(aId, { depth: "deep" })).item;
        for (const field of ["title", "body", "status", "priority", "tags", "type", "author", "description", "deadline", "assignee", "parent", "goal", "objective", "sprint", "release", "dependencies", "estimated_minutes", "close_reason"] as const) assert.deepEqual(actualItem[field], modelItem[field], `sequence ${sequence} field ${field}`);
        const exported = itemToLinearPayload(actualItem);
        assert.equal(exported.estimate, points ?? undefined);
        assert.ok(exported.labels!.every((label) => !label.startsWith("linear-estimate:")));
        const exportedThroughHost = await harness.runExporter({ exporter: "linear", pmRoot: actual.root, options: {}, global: { json: true } });
        const payload = (exportedThroughHost.result as { payloads: Array<{ linearId?: string; estimate?: number }> }).payloads.find((row) => row.linearId === remote.id);
        assert.ok(payload); assert.equal(payload.estimate, points ?? undefined);
      }
      if (local === 0) {
        // An unrelated native effort and relationship survive all following provider replays.
        for (const pm of [actual.pm, model]) await pm.update(aId, { parent: aParent.item.id, estimatedMinutes: "777", dep: [`id=${aParent.item.id},kind=related_to`] });
      }
    }
    const events = await readHistoryEntries(getHistoryPath(actual.root, aId), aId);
    assert.ok(events.length > 25);
  }
  assert.ok(routes.every((route) => (routeCounts.get(route) ?? 0) >= 125));
});

test("network inspection and every importer alias preserve the unit contract and typed refusals", async (t) => {
  const { root } = await fixture(t);
  const provider = issue();
  const state = { scale: { ...team }, mode: "valid", queries: [] as string[] };
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (chunk: Buffer) => { raw += chunk.toString(); }); req.on("end", () => {
      const { query } = JSON.parse(raw) as { query: string }; state.queries.push(query); assert.ok(!query.trimStart().startsWith("mutation"));
      const pageInfo = { hasNextPage: false, endCursor: null };
      const data = query.includes("LinearEstimateScale") ? { teams: { nodes: state.mode === "empty" ? [] : [state.scale] } } : query.includes("LinearSchema") ? {
        teams: { nodes: [{ ...team, cyclesEnabled: false, triageEnabled: false, defaultIssueState: null, states: { nodes: [{ id: "queue", ...provider.state }], pageInfo } }] }, issueLabels: { nodes: [], pageInfo },
      } : query.includes("viewer") ? { viewer: { id: "reader" } } : { issues: { nodes: [provider], pageInfo } };
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify({ data, ...(state.mode === "errors" ? { errors: [{ message: "denied" }] } : {}) }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const saved = { LINEAR_API_KEY: process.env.LINEAR_API_KEY, LINEAR_API_BASE_URL: process.env.LINEAR_API_BASE_URL };
  process.env.LINEAR_API_KEY = "synthetic-key"; process.env.LINEAR_API_BASE_URL = `http://127.0.0.1:${address.port}/graphql`;
  t.after(async () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await new Promise<void>((done) => server.close(() => done())); });
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  const file = join(root, "conversion.json"); await writeFile(file, JSON.stringify(mapping));
  for (const atomic of [false, true]) for (const route of ["sync", "linear", "linear-sync"]) {
    provider.description = atomic ? " CRLF\r\nbody " : " LF\nbody ";
    const options = { team: "ENG", estimateMapping: file, atomic, skipPreflightNetwork: true };
    const result = route === "sync" ? await harness.runCommand({ command: "linear sync", pmRoot: root, options, global: { json: true } }) : await harness.runImporter({ importer: route, pmRoot: root, options, global: { json: true } });
    assert.equal(result.exitCode ?? 0, 0, JSON.stringify(result));
    const inspection = await harness.runCommand({ command: "linear estimates", pmRoot: root, options: { team: "ENG", limit: "1" }, global: { json: true } });
    assert.equal((inspection.result as LinearEstimateReport).rows[0].minutes, 240);
    const exported = await harness.runExporter({ exporter: "linear", pmRoot: root, options: {}, global: { json: true } }); assert.equal(exported.exitCode ?? 0, 0);
  }
  for (const mode of ["empty", "wrong", "errors"]) {
    state.mode = mode; if (mode === "wrong") state.scale = { ...team, key: "OPS" };
    const result = await harness.runCommand({ command: "linear estimates", pmRoot: root, options: { team: "ENG" }, global: {} });
    assert.equal(result.exitCode, 2); assert.equal((result.result as { code: string }).code, "estimate_scale_unavailable");
  }
  delete process.env.LINEAR_API_KEY;
  const denied = await harness.runCommand({ command: "linear estimates", pmRoot: root, options: { team: "ENG" }, global: {} }); assert.equal(denied.exitCode, 2);
  await assert.rejects(inspectLinearEstimates({ team }, join(root, "missing")), refusal("estimate_local_unavailable"));
  assert.ok(state.queries.length > 10);
});

test("unit plans preview exact SDK effects and refuse foreign deterministic targets", async (t) => {
  const { root, pm } = await fixture(t);
  const value = issue("preview");
  const options = { team: "ENG", limit: 10, atomic: true, estimateMapping: mapping };
  const fetchIssues = async () => [value];
  const preview = await syncLinearIssues({ ...options, dryRun: true }, root, { fetchIssues });
  assert.equal((await pm.listAllComplete()).items.length, 0);
  const applied = await syncLinearIssues(options, root, { fetchIssues });
  for (const key of ["created", "updated", "skipped", "synced"] as const) assert.equal(preview[key], applied[key]);
  const unchangedPreview = await syncLinearIssues({ ...options, dryRun: true }, root, { fetchIssues });
  const unchanged = await syncLinearIssues(options, root, { fetchIssues }); assert.equal(unchangedPreview.synced, unchanged.synced);
  const again = await syncLinearIssues(options, root, { fetchIssues }); assert.equal(again.skipped, 0);
  assert.equal(again.synced, 0);
  const settings = await readSettings(root);
  const occupied = issue("occupied");
  const id = deriveAtomicItemId("ENG", occupied.identifier, settings.id_prefix, normalizeItemId);
  await pm.create({ id, title: "Unrelated context", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  const foreign = await sync(root, occupied, true); assert.equal(foreign.skipped, 1); assert.equal((await pm.get(id)).item.title, "Unrelated context");
  const conflicting = issue("mixed"); conflicting.team = { ...team, key: "OPS" };
  await assert.rejects(syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [conflicting] }), refusal("estimate_scope_mismatch"));
  const drift = issue("drift"); drift.team = { ...team, issueEstimationExtended: true };
  await assert.rejects(syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [value, drift] }), refusal("estimate_target_changed"));
  const legacy = issue("legacy"); delete legacy.team;
  await assert.rejects(syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [value, legacy] }), refusal());
});

test("compensation preserves peer edits and only restores positively owned target revisions", async (t) => {
  const { root, pm } = await fixture(t);
  for (const existing of [false, true]) for (const peer of [false, true]) {
    const value = issue(`compensate-${existing}-${peer}`);
    if (existing) await sync(root, value);
    const selected = (await pm.listAllComplete()).items.find((row) => row.description?.includes(value.id));
    value.title = "Changed before deliberate failure";
    await assert.rejects(sync(root, value, true, undefined, async (stage, id) => {
      if (stage === "after_write") { if (peer) await pm.update(id, { title: "Peer preserved" }); throw new Error("deliberate failure"); }
    }), /deliberate failure/);
    const after = (await pm.listAllComplete()).items.find((row) => row.description?.includes(value.id));
    if (peer) assert.equal(after?.title, "Peer preserved"); else if (existing) assert.equal(after?.title, selected?.title); else assert.equal(after, undefined);
  }
  const value = issue("compensation-boundary"); await sync(root, value);
  value.title = "Changed";
  await assert.rejects(sync(root, value, true, undefined, async (stage, id) => {
    if (stage === "after_write") throw new Error("deliberate failure");
    if (stage === "before_compensate") await pm.update(id, { title: "Late peer" });
  }), /deliberate failure/);
  assert.ok((await pm.listAllComplete()).items.some((row) => row.title === "Late peer"));
});

test("custom terminal roles and retry reasons agree with the target SDK registry", async (t) => {
  const base = await fixture(t);
  for (const [index, role] of [[0, ["active"]], [1, ["terminal", "terminal_done"]], [2, ["terminal", "terminal_canceled"]]] as const) {
    const root = join(base.root, `registry-${index}`); await mkdir(root);
    const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" }); await pm.init("units");
    const name = `custom-${index}`; await pm.schemaAddStatus(name, { role: [...role] });
    const value = issue(`roles-${index}`); value.state = { name, type: "started" };
    const reason = role.some((value) => value === "terminal") ? `Linear issue ${value.identifier} terminal` : undefined;
    const reference = await pm.create({ title: "Reference", status: name, closeReason: reason, parent: "none", unset: ["goal", "objective", "sprint", "release"] });
    for (const replay of [false, true]) {
      if (replay) await pm.update(reference.item.id, { status: name, closeReason: reason });
      await syncLinearIssues({ team: "ENG", limit: 10, statusMap: { [name]: name } }, root, { fetchIssues: async () => [value] });
      const row = (await pm.listAllComplete()).items.find((item) => item.description?.includes(value.id)); assert.ok(row);
      const actual = (await pm.get(row.id, { depth: "deep" })).item;
      const expected = (await pm.get(reference.item.id, { depth: "deep" })).item;
      assert.equal(actual.close_reason, expected.close_reason, `registry ${index} replay ${replay}`);
      assert.equal(actual.status, expected.status);
    }
  }
});

test("post-write peer state never becomes a compensation ownership proof", async (t) => {
  const { root, pm } = await fixture(t);
  const value = issue("producer-proof");
  await assert.rejects(sync(root, value, true, undefined, async (stage, id) => {
    if (stage === "written") await pm.update(id, { title: "Peer edit before ownership observation" });
    if (stage === "after_write") throw new Error("deliberate post-write failure");
  }), /deliberate post-write failure/);
  const item = (await pm.listAllComplete()).items.find((row) => row.description?.includes(value.id));
  assert.equal(item?.title, "Peer edit before ownership observation");
});

test("multi-item imports sort targets, replay without duplicates and isolate a superseded item", async (t) => {
  const { root, pm } = await fixture(t);
  const a = issue("batch-a"), z = issue("batch-z");
  const observed: string[] = [];
  const initial = await syncLinearIssues({ team: "ENG", limit: 10, atomic: true }, root, {
    fetchIssues: async () => [z, a], onEstimateBoundary: async (stage, id) => { if (stage === "observed") observed.push(id); },
  });
  assert.equal(initial.created, 2);
  const items = (await pm.listAllComplete()).items;
  const aId = items.find((item) => item.description?.includes(a.id))!.id;
  const zId = items.find((item) => item.description?.includes(z.id))!.id;
  assert.deepEqual(observed, [aId, zId]);
  const replay = await syncLinearIssues({ team: "ENG", limit: 10, atomic: true }, root, { fetchIssues: async () => [a, z] });
  assert.equal(replay.synced, 0); assert.equal(replay.skipped, 0); assert.equal((await pm.listAllComplete()).items.length, 2);
  a.title = "Changed A"; z.title = "Changed Z";
  let injected = false;
  const changed = await syncLinearIssues({ team: "ENG", limit: 10, atomic: true }, root, {
    fetchIssues: async () => [z, a], onEstimateBoundary: async (stage, id) => {
      if (stage === "before_write" && id === aId && !injected) { injected = true; await pm.update(aId, { title: "Peer preserved" }); }
    },
  });
  assert.equal(changed.updated, 1); assert.equal(changed.skipped, 1);
  assert.deepEqual(changed.estimateSkips, [{ id: aId, reason: "superseded" }]);
  assert.equal((await pm.get(aId)).item.title, "Peer preserved");
  assert.equal((await pm.get(zId)).item.title, `[${z.identifier}] Changed Z`);
});

test("provider labels resembling unit and cycle tags round-trip as literal labels", async (t) => {
  const { root, pm } = await fixture(t); const value = issue("label-collision");
  value.labels.nodes = [{ name: "estimate:9" }, { name: "cycle:foreign" }];
  value.cycle = { name: "Actual" }; await sync(root, value, true, mapping);
  const item = (await pm.listAllComplete({ includeBody: true })).items[0];
  const payload = itemToLinearPayload(item);
  assert.equal(payload.estimate, 5); assert.equal(payload.cycleName, "actual");
  assert.ok(payload.labels!.includes("estimate:9")); assert.ok(payload.labels!.includes("cycle:foreign"));
  assert.equal((await inspectLinearEstimates({ team }, root)).rows[0].minutes, 240);
  const longest = "estimate:" + "界".repeat(32759);
  const literal = issue("long-label"); literal.labels.nodes = [{ name: longest }];
  assert.ok(itemToLinearPayload(buildItemPlan(literal, {})).labels!.includes(longest));
});
