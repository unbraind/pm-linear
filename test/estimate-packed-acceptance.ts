/** Packed estimate commands across project-local, npm-global, Bun-global, npx and bunx hosts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireLock, PmClient } from "@unbrained/pm-cli/sdk";
import { buildItemPlan, encodeLinearEstimate, linearEstimateScaleRevision, syncLinearIssues, itemToLinearPayload, type LinearEstimateReport, type LinearOwnershipReport, type LinearIssue } from "../index.ts";

import { referenceLifecycle } from "./native-reference.ts";

const scratch = await mkdtemp(join(tmpdir(), "linear-units-packed-"));
const requestedHostVersion = process.env.LINEAR_ACCEPTANCE_HOST_VERSION ?? "2026.10.28";
const vars = { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", HOME: join(scratch, "home"), NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", NPM_CONFIG_PREFER_OFFLINE: "true", npm_config_prefer_offline: "true", NPM_CONFIG_CACHE: join(tmpdir(), "linear-estimate-acceptance-cache"), GIT_CEILING_DIRECTORIES: tmpdir() };
await mkdir(vars.HOME);
let lastDiagnostics = "", commandCount = 0;
/** Commands inherit only explicit noncredential configuration and synthetic provider credentials. */
async function run(bin: string, args: string[], cwd = scratch, extra: Record<string, string> = {}, expectedExit = 0) {
  commandCount++;
  if (commandCount % 10 === 0) process.stdout.write(`packed commands: ${commandCount}\n`);
  return new Promise<string>((done, fail) => {
    const child = spawn(bin, args, { cwd, env: { ...vars, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.on("error", fail);
    child.on("exit", (code) => {
      lastDiagnostics = error;
      if (code === expectedExit) done(output || error);
      else fail(new Error(`Packed ${args[0]} failed (${code}): ${(output + error).slice(-1600)}`));
    });
  });
}
const team = { id: "team-packed", key: "PACK", issueEstimationType: "fibonacci", issueEstimationAllowZero: false, issueEstimationExtended: false };
const issue: LinearIssue = { id: "remote-packed", identifier: "PACK-1", title: "Five native points", description: "Synthetic\r\nbody", priority: 2, estimate: 5, team,
  state: { name: "Queue", type: "unstarted" }, labels: { nodes: [], pageInfo: { hasNextPage: false } } as LinearIssue["labels"], dueDate: null };
let requests = 0;
let recoveryIssues: LinearIssue[] | undefined;
let peerWrite: (() => Promise<void>) | undefined;
let peerError: unknown;
const server = http.createServer((req, res) => {
  let raw = ""; req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
  req.on("end", async () => {
    const { query } = JSON.parse(raw) as { query: string };
    assert.ok(!query.trimStart().startsWith("mutation")); requests++;
    if (query.includes("issues(") && peerWrite) {
      const write = peerWrite; peerWrite = undefined;
      try { await write(); } catch (error: unknown) { peerError = error; res.writeHead(500); res.end(); return; }
    }
    const pageInfo = { hasNextPage: false, endCursor: null };
    const selected = { ...issue, updatedAt: "2026-10-29T00:00:00Z" };
    if (!/\bteam\s*\{/.test(query)) delete selected.team;
    const data = query.includes("LinearEstimateScale") ? { teams: { nodes: [team] } } : query.includes("LinearSchema") ? {
      teams: { nodes: [{ ...team, cyclesEnabled: false, triageEnabled: false, defaultIssueState: null, states: { nodes: [{ id: "queue", ...issue.state }, { id: "completed", name: "Completed", type: "completed" }], pageInfo } }] }, issueLabels: { nodes: [], pageInfo },
    } : query.includes("viewer") ? { viewer: { id: "reader" } } : query.includes("LinearOwnership") ? { issue: selected } : { issues: { nodes: recoveryIssues?.map((value) => ({ ...value, updatedAt: selected.updatedAt })) ?? [selected], pageInfo } };
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify({ data }));
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address(); assert.ok(address && typeof address !== "string");
const network = { LINEAR_API_KEY: "synthetic-key", LINEAR_API_BASE_URL: `http://127.0.0.1:${address.port}/graphql` };
try {
  const packed = JSON.parse(await run("npm", ["pack", "--json", "--pack-destination", scratch], resolve(import.meta.dirname, ".."))) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const artifact = join(scratch, packed[0].filename);
  assert.ok(packed[0].files.some((file) => file.path === "dist/index.js"));
  assert.ok(packed[0].files.every((file) => !/\.agents\/|test\//.test(file.path)));
  const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
  await run("tar", ["-xzf", artifact, "-C", scratch]);
  const source = join(scratch, "package");
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as { pm_min_version: string };
  const hostVersions = [...new Set([manifest.pm_min_version, requestedHostVersion])];
  assert.ok(hostVersions.every((version) => /^\d{4}\.\d{1,2}\.\d{1,2}$/.test(version)));
  const results = [];
  for (const hostVersion of hostVersions) {
    const host = `@unbrained/pm-cli@${hostVersion}`;
    const hostRoot = join(scratch, "hosts", hostVersion); await mkdir(hostRoot, { recursive: true });
    const local = join(hostRoot, "local"), global = join(hostRoot, "global");
    await run("npm", ["install", "--prefix", local, "--ignore-scripts", artifact, host]);
    await run("npm", ["install", "--global", "--prefix", global, "--ignore-scripts", artifact, host]);
    const bunVars = { BUN_INSTALL_GLOBAL_DIR: join(hostRoot, "bun-global"), BUN_INSTALL_BIN: join(hostRoot, "bun-bin") };
    await run("bun", ["add", "--global", "--ignore-scripts", artifact, host], scratch, bunVars);
    const modes = [
      { name: "project-local", bin: join(local, "node_modules/.bin/pm"), args: [], vars: {} },
      { name: "npm-global", bin: join(global, "bin/pm"), args: [], vars: {} },
      { name: "bun-global", bin: join(bunVars.BUN_INSTALL_BIN, "pm"), args: [], vars: bunVars },
      { name: "npx", bin: "npm", args: ["exec", "--yes", `--package=${host}`, "--", "pm"], vars: {} },
      { name: "bunx", bin: "bun", args: ["x", "--package", host, "pm"], vars: bunVars },
    ];
    for (const mode of modes) {
      const commandsBefore = commandCount;
      const tracker = join(hostRoot, "trackers", mode.name); const pm = new PmClient({ pmRoot: tracker, noExtensions: true, author: "fixture" }); await pm.init("packed");
      const seeded = await syncLinearIssues({ team: "PACK", limit: 10, atomic: true, forwardOnly: true }, tracker, {
        fetchIssues: async () => [issue], onEstimateBoundary: async (stage) => { if (stage === "after_write") throw new Error("Packed observer failure"); },
      });
      assert.equal(seeded.created, 1); assert.equal(seeded.importResults?.[0].code, "import_observer_failed"); assert.equal(seeded.exit_code, 1);
      const prefix = [...mode.args, "--pm-path", tracker]; const extra = { ...mode.vars, ...network };
      await run(mode.bin, [...prefix, "package", "install", source, "--project"], scratch, mode.vars);
      // A real consumer imports this artifact's public entrypoint. SDK acquisition
      // stays inside its supported loader and the host-installed peer context.
      const sdkRoot = join(hostRoot, "sdk-contract", mode.name);
      await new PmClient({ pmRoot: sdkRoot, noExtensions: true, author: "fixture" }).init("sdk-contract");
      const sdkPrefix = [...mode.args, "--pm-path", sdkRoot];
      await run(mode.bin, [...sdkPrefix, "package", "install", source, "--project"], scratch, mode.vars);
      const sdkInput = join(scratch, "sdk-input.json"), sdkProgram = join(scratch, "sdk-consumer.mjs");
      await writeFile(sdkInput, JSON.stringify(issue));
      const sdkEntry = pathToFileURL(join(sdkRoot, "extensions", "pm-linear", "dist", "index.js")).href;
      await writeFile(sdkProgram, `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { locateItem, PmClient } from ${JSON.stringify(pathToFileURL(join(local, "node_modules/@unbrained/pm-cli/dist/sdk/index.js")).href)};
import { buildItemPlan, syncLinearIssues, importLinearAtomic, importLinearForwardOnly } from ${JSON.stringify(sdkEntry)};
const root = process.argv[2], original = JSON.parse(await readFile(process.argv[3], "utf8"));
let checks = 0; const ids = [];
for (const scaled of [false, true]) {
  const source = structuredClone(original); source.id += scaled ? "-scaled" : "-legacy"; source.identifier += scaled ? "-scaled" : "-legacy";
  if (!scaled) delete source.team;
  const corpus = Array.from({ length: 500 }, (_, index) => ({ ...structuredClone(source), id: source.id + index, identifier: source.identifier + index, description: index % 2 ? " Raw\\r\\ncorpus " : " Raw\\ncorpus " }));
  for (const atomic of [false, true]) for (const dryRun of [false, true]) {
    const result = await syncLinearIssues({ team: "PACK", limit: 500, atomic, forwardOnly: true, dryRun, stateFilter: "missing" }, root, { fetchIssues: async () => corpus });
    assert.deepEqual(result.issues, corpus); assert.equal(result.skipped, 500); checks++;
  }
  const changed = { ...structuredClone(source), title: " SDK raw title\\r\\n " };
  for (const [atomic, remote] of [[false, changed], [false, changed], [true, source]]) {
    const result = await syncLinearIssues({ team: "PACK", limit: 10, atomic, forwardOnly: true }, root, { fetchIssues: async () => [remote] });
    assert.deepEqual(result.issues, [remote]); assert.equal(result.skipped, 0); checks++;
  }
  const assigned = { ...structuredClone(source), assignee: { name: "Provider Agent", email: "provider@example.invalid" } };
  const seeded = await syncLinearIssues({ team: "PACK", limit: 10 }, root, { fetchIssues: async () => [assigned] });
  assert.deepEqual(seeded.issues, [assigned]); checks++;
  const cleared = structuredClone(assigned); if (!scaled) delete cleared.assignee;
  const result = await syncLinearIssues({ team: "PACK", limit: 10, ...(scaled ? { fieldMap: { assignee: "ignore" } } : {}) }, root, { fetchIssues: async () => [cleared] });
  assert.deepEqual(result.issues, [cleared]); assert.equal(result.skipped, 0); ids.push(result.importResults[0].id); checks++;
}
const receipt = await importLinearForwardOnly(root, "PACK", []); assert.equal(Object.hasOwn(receipt, "issues"), false); checks++;
const client = new PmClient({ pmRoot: root, noExtensions: true, author: "fixture" });
await assert.rejects(importLinearAtomic(root, "PACK", []), { code: "atomic_unavailable" }); checks++;
await assert.rejects(syncLinearIssues({ team: "PACK", limit: 1, atomic: true }, root, { fetchIssues: async () => { assert.fail("atomic refusal must precede provider access"); } }), { code: "atomic_unavailable" }); checks++;
for (const scaled of [false, true]) {
  const remote = structuredClone(original); remote.id += "-fault-" + scaled; remote.identifier += "-fault-" + scaled; if (!scaled) delete remote.team;
  const seeded = await syncLinearIssues({ team: "PACK", limit: 1 }, root, { fetchIssues: async () => [remote] });
  const located = await locateItem(root, seeded.importResults[0].id); assert.ok(located);
  const rename = fs.rename; let faults = 0;
  fs.rename = async (from, to) => {
    if (String(to) === located.itemPath && /status: closed/.test(await fs.readFile(from, "utf8"))) { faults++; throw Object.assign(new Error("Synthetic close IO fault"), { code: "EIO" }); }
    return rename(from, to);
  }; syncBuiltinESMExports();
  remote.title = "Partial native update"; remote.state = { name: "Completed", type: "completed" };
  try {
    const result = await syncLinearIssues({ team: "PACK", limit: 1 }, root, { fetchIssues: async () => [remote] });
    assert.ok(faults); assert.equal(result.exit_code, 1); assert.equal(result.unconfirmed, 1); checks++;
  } finally { fs.rename = rename; syncBuiltinESMExports(); }
  assert.equal((await syncLinearIssues({ team: "PACK", limit: 1 }, root, { fetchIssues: async () => [remote] })).exit_code ?? 0, 0); checks++;
  const plan = buildItemPlan(remote, {}), entry = { ...plan, linearId: remote.id, identifier: remote.identifier };
  await client.create({ title: "Duplicate link", description: plan.description, parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  const before = (await client.listAllComplete({ includeBody: true })).items;
  const conflict = await importLinearForwardOnly(root, "PACK", [entry]); assert.equal(conflict.exit_code, 1); assert.equal(conflict.created, 0);
  assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, before); checks++;
  const inconsistent = { ...entry, linearId: remote.id + "-declared-other", identifier: remote.identifier + "-mismatched" };
  for (const compatibility of [false, true]) {
    const refused = compatibility ? await importLinearAtomic(root, "PACK", [inconsistent], { forwardOnly: true }) : await importLinearForwardOnly(root, "PACK", [inconsistent]);
    assert.equal(refused.created, 0); assert.equal(refused.exit_code, 1); assert.equal(refused.importResults[0].code, "import_conflict");
    assert.equal(refused.itemIds.size, 0); assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, before); checks++;
  }
}
console.log(JSON.stringify({ checks, ids }));
`);
      const sdkContract = JSON.parse(await run(process.execPath, [sdkProgram, sdkRoot, sdkInput], scratch, extra)) as { checks: number; ids: string[] };
      assert.equal(sdkContract.checks, 31); assert.equal(sdkContract.ids.length, 2);
      const scopeUnset = ["goal", "objective", "sprint", "release"].flatMap((field) => ["--unset", field]);
      const reference = JSON.parse(await run(mode.bin, [...sdkPrefix, "--no-extensions", "create", "--title", "Native unset reference", "--assignee", "Local Agent", "--parent", "none", ...scopeUnset, "--json"], scratch, mode.vars)) as { id: string };
      await run(mode.bin, [...sdkPrefix, "--no-extensions", "update", reference.id, "--unset", "assignee", "--parent", "none", ...scopeUnset, "--json"], scratch, mode.vars);
      const nativeUnset = JSON.parse(await run(mode.bin, [...sdkPrefix, "--no-extensions", "show", reference.id, "--json"], scratch, mode.vars)) as { item: { assignee?: string } };
      for (const id of sdkContract.ids) {
        const current = JSON.parse(await run(mode.bin, [...sdkPrefix, "--no-extensions", "show", id, "--json"], scratch, mode.vars)) as { item: { assignee?: string } };
        assert.deepEqual(current.item.assignee, nativeUnset.item.assignee, "packed legacy/scaled clearing equals native SDK unset");
      }
      const restored = JSON.parse(await run(mode.bin, [...prefix, "linear", "sync", "--team", "PACK", "--json"], scratch, extra)) as { created: number; skipped: number };
      assert.equal(restored.created, 0); assert.equal(restored.skipped, 0, "the packed sync re-reads and recognizes the earlier success");
      const native = JSON.parse(await run(mode.bin, [...prefix, "linear", "estimates", "--team", "PACK", "--json"], scratch, extra)) as LinearEstimateReport;
      assert.equal(native.rows[0].points, 5); assert.equal(native.rows[0].minutes, null);
      const file = join(scratch, "mapping.json");
      await writeFile(file, JSON.stringify({ teamId: team.id, scaleRevision: linearEstimateScaleRevision(team), entries: [{ points: 5, minutes: 240 }] }));
      for (const command of [["linear", "import"], ["linear-sync", "import"]]) await run(mode.bin, [...prefix, ...command, "--team", "PACK", "--estimate-mapping", file, "--atomic", "--forward-only", "--json"], scratch, extra);
      const raw = await run(mode.bin, [...prefix, "linear", "estimates", "--team", "PACK", "--json"], scratch, extra);
      const converted = JSON.parse(raw) as LinearEstimateReport; assert.equal(converted.rows[0].minutes, 240);
      const toon = await run(mode.bin, [...prefix, "linear", "estimates", "--team", "PACK"], scratch, extra); assert.match(toon, /converted/);
      const ownershipRaw = await run(mode.bin, [...prefix, "linear", "ownership", "--item", converted.rows[0].id, "--json"], scratch, extra);
      const ownership = JSON.parse(ownershipRaw) as LinearOwnershipReport;
      assert.ok(ownership.observation.fields.every((field) => field.local === field.provider), mode.name);
      const base = join(scratch, `${mode.name}-ownership.json`); await writeFile(base, JSON.stringify(ownership.observation));
      const ownershipArgs = [...prefix, "linear", "ownership", "--item", converted.rows[0].id, "--base", base];
      const acknowledged = JSON.parse(await run(mode.bin, [...ownershipArgs, "--json"], scratch, extra)) as LinearOwnershipReport;
      assert.ok(acknowledged.fields.every((field) => field.decision === "unchanged"), mode.name);
      const ownershipToon = await run(mode.bin, ownershipArgs, scratch, extra); assert.match(ownershipToon, /unchanged/); assert.doesNotMatch(ownershipToon, /unknown_base/);
      let boundaryProcessChecks = 0;
      for (const command of [["linear", "sync"], ["linear", "import"], ["linear-sync", "import"]]) for (const json of [true, false]) {
        const refused = await run(mode.bin, [...prefix, ...command, "--team", "PACK", "--atomic", ...(json ? ["--json"] : [])], scratch, mode.vars, 2);
        assert.match(refused, /atomic_unavailable/); boundaryProcessChecks++;
      }
      const previousTitle = issue.title;
      const beforePreview = JSON.parse(await run(mode.bin, [...prefix, "--no-extensions", "show", converted.rows[0].id, "--json"], scratch, mode.vars)) as unknown;
      try {
        issue.title = "Only a simulated provider edit";
        for (const command of [["linear", "sync"], ["linear", "import"], ["linear-sync", "import"]]) for (const json of [true, false]) {
          const simulated = await run(mode.bin, [...prefix, ...command, "--team", "PACK", "--atomic", "--forward-only", "--dry-run", ...(json ? ["--json"] : [])], scratch, extra);
          if (json) { const receipt = JSON.parse(simulated) as { dryRun: boolean; updated: number; atomic: boolean }; assert.equal(Object.hasOwn(receipt, "issues"), false); assert.equal(receipt.dryRun, true); assert.equal(receipt.updated, 1); assert.equal(receipt.atomic, false); }
          else { assert.match(simulated, /dryRun: true/); assert.doesNotMatch(simulated, /^issues:/m); }
          assert.match(lastDiagnostics, /Would sync|Would import/);
          const afterPreview = JSON.parse(await run(mode.bin, [...prefix, "--no-extensions", "show", converted.rows[0].id, "--json"], scratch, mode.vars)) as unknown;
          assert.deepEqual(afterPreview, beforePreview, "every packed dry-run preserves SDK-read native state");
        }
        const release = await acquireLock(tracker, converted.rows[0].id, 600, "peer");
        try {
          for (const json of [true, false]) await assert.rejects(run(mode.bin, [...ownershipArgs, ...(json ? ["--json"] : [])], scratch, extra), /projection_failed/);
        } finally { await release(); }
      } finally { issue.title = previousTitle; }
      const legacyRoot = join(hostRoot, "legacy", mode.name);
      const legacy = new PmClient({ pmRoot: legacyRoot, noExtensions: true, author: "fixture" }); await legacy.init("legacy");
      await legacy.schemaAddStatus("finished-custom", { role: ["terminal_done"] });
      const legacyIssue = { ...issue, team: undefined, state: { name: "Provider finished", type: "completed" } };
      const legacyPlan = buildItemPlan(legacyIssue, {});
      const legacyItem = await legacy.create({ ...legacyPlan, tags: JSON.stringify(legacyPlan.tags), status: "finished-custom", closeReason: "Synthetic terminal state",
        parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive" });
      const legacyPrefix = [...mode.args, "--pm-path", legacyRoot];
      await run(mode.bin, [...legacyPrefix, "package", "install", source, "--project"], scratch, mode.vars);
      const savedTeam = issue.team, savedState = issue.state;
      try {
        delete issue.team; issue.state = legacyIssue.state;
        const legacyReport = JSON.parse(await run(mode.bin, [...legacyPrefix, "linear", "ownership", "--item", legacyItem.item.id, "--json"], scratch, extra)) as LinearOwnershipReport;
        assert.equal(legacyReport.ok, true, mode.name);
        const status = legacyReport.observation.fields.find((field) => field.field === "status")!;
        assert.notEqual(status.local, status.provider, "custom terminal role projects the default provider completion through the native SDK");
      } finally { issue.team = savedTeam; issue.state = savedState; }
      const exported = await run(mode.bin, [...prefix, "linear", "export", "--json"], scratch, mode.vars); assert.match(exported, /"estimate":\s*5/); assert.doesNotMatch(exported, /linear-estimate:/);
      let interleavings = 0;
      for (const command of [["linear", "sync"], ["linear", "import"], ["linear-sync", "import"]]) for (const json of [true, false]) {
        const minutes = 300 + interleavings;
        const peerTags = ["estimate:5", encodeLinearEstimate(team, 5, { teamId: team.id, scaleRevision: linearEstimateScaleRevision(team), entries: [{ points: 5, minutes }] })];
        peerWrite = async () => {
          const mutation = JSON.parse(await run(mode.bin, [...prefix, "--no-extensions", "update", converted.rows[0].id,
            "--tags", JSON.stringify(peerTags), "--parent", "none", ...["goal", "objective", "sprint", "release"].flatMap((field) => ["--unset", field]), "--author", "peer", "--json"], scratch, mode.vars)) as { changed_field_count: number };
          assert.ok(mutation.changed_field_count > 0, "the ordinary peer writer actually changed its target");
        };
        // Provider acquisition occurs after the planning snapshot. An independent
        // ordinary native CLI writer must win, for every alias and renderer.
        const receipt = await run(mode.bin, [...prefix, ...command, "--team", "PACK", ...(json ? ["--json"] : ["--atomic", "--forward-only"])], scratch, extra, 1);
        assert.ifError(peerError);
        assert.equal(peerWrite, undefined, "the peer update ran at the provider boundary");
        if (json) {
          const parsed = JSON.parse(receipt) as { skipped: number; estimateSkips: Array<{ reason: string }> };
          assert.equal(parsed.skipped, 1, `${mode.name} ${command.join(" ")} interleaving ${interleavings}: ${receipt}`); assert.equal(parsed.estimateSkips[0].reason, "superseded");
        } else assert.match(receipt, /superseded/);
        const retained = JSON.parse(await run(mode.bin, [...prefix, "linear", "estimates", "--team", "PACK", "--json"], scratch, extra)) as LinearEstimateReport;
        assert.equal(retained.rows[0].minutes, minutes, `${mode.name} ${command.join(" ")} preserves the peer conversion`);
        interleavings++;
      }
      let restoredAliases = 0;
      for (const importer of ["linear", "linear-sync"]) {
        const retryRoot = join(hostRoot, "retry", mode.name, importer);
        const retryClient = new PmClient({ pmRoot: retryRoot, noExtensions: true, author: "fixture" }); await retryClient.init("retry");
        const values = ["a", "z"].map((suffix) => ({ ...structuredClone(issue), id: `remote-retry-${suffix}`, identifier: `PACK-retry-${suffix}` }));
        const conversion = { teamId: team.id, scaleRevision: linearEstimateScaleRevision(team), entries: [{ points: 5, minutes: 240 }] };
        const seededBatch = await syncLinearIssues({ team: "PACK", limit: 10, atomic: true, forwardOnly: true, estimateMapping: conversion }, retryRoot, {
          fetchIssues: async () => values, onEstimateBoundary: async (stage, id) => { if (stage === "before_update" && id.endsWith("-z")) throw new Error("Packed item failure"); },
        });
        assert.equal(seededBatch.created, 1); assert.equal(seededBatch.skipped, 1);
        assert.equal((await retryClient.listAllComplete()).items.length, 1);
        const retryPrefix = [...mode.args, "--pm-path", retryRoot];
        await run(mode.bin, [...retryPrefix, "package", "install", source, "--project"], scratch, mode.vars);
        try {
          recoveryIssues = values.map((value) => ({ ...value, title: " Fresh replay ", description: " Fresh\r\nbody ", ...(value.id.endsWith("-a") ? { state: { name: "Completed", type: "completed" } } : {}) }));
          const receipt = JSON.parse(await run(mode.bin, [...retryPrefix, importer, "import", "--team", "PACK", "--estimate-mapping", file, "--atomic", "--forward-only", "--json"], scratch, extra)) as { created: number; updated: number; skipped: number; atomic: boolean; importMode: string };
          assert.equal(receipt.importMode, "forward-only"); assert.equal(receipt.atomic, false); assert.equal(receipt.updated, 1, JSON.stringify(receipt) + lastDiagnostics.slice(-2400)); assert.equal(receipt.created, 1); assert.equal(receipt.skipped, 0);
          const units = JSON.parse(await run(mode.bin, [...retryPrefix, "linear", "estimates", "--team", "PACK", "--json"], scratch, extra)) as LinearEstimateReport;
          assert.equal(units.counts.matched, 2); assert.ok(units.rows.every((row) => row.points === 5 && row.minutes === 240), "retry retains the earlier explicit mapping");
          const replay = await run(mode.bin, [...retryPrefix, importer, "import", "--team", "PACK", "--atomic", "--forward-only"], scratch, extra);
          assert.match(replay, /skipped: 0/); assert.doesNotMatch(replay, /foreign|superseded/);
          const exported = JSON.parse(await run(mode.bin, [...retryPrefix, "linear", "export", "--json"], scratch, mode.vars)) as { payloads: Array<{ linearId: string; title: string; estimate: number; description: string }> };
          const referenceRoot = join(hostRoot, "reference", mode.name, importer);
          const reference = new PmClient({ pmRoot: referenceRoot, noExtensions: true, author: "fixture" }); await reference.init("reference");
          assert.equal(exported.payloads.length, 2);
          const byProviderId = new Map(exported.payloads.map((row) => [row.linearId, row]));
          assert.equal(byProviderId.size, 2);
          for (const value of recoveryIssues) {
            const plan = buildItemPlan(value, {}, {}, undefined, conversion);
            const lifecycle = await referenceLifecycle(referenceRoot, undefined, plan.status, plan.assignee, `Linear issue ${value.identifier} terminal`);
            const created = await reference.create({ ...plan, ...lifecycle, tags: JSON.stringify(plan.tags), parent: "none", unset: ["goal", "objective", "sprint", "release", ...lifecycle.unset] });
            const expected = itemToLinearPayload((await reference.get(created.item.id, { depth: "deep" })).item);
            const actual = byProviderId.get(value.id); assert.ok(actual);
            for (const field of ["title", "description", "estimate"] as const) assert.deepEqual(actual[field], expected[field], "packed replay equals SDK-normalized reference");
          }
          restoredAliases++;
        } finally { recoveryIssues = undefined; }
      }
      const faultProgram = join(scratch, "native-close-io-fault.mjs");
      await writeFile(faultProgram, `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename, target = ${JSON.stringify((await pm.get(converted.rows[0].id)).item.id)};
fs.rename = async (from, to) => {
  if (String(to).includes(${JSON.stringify(tracker)}) && String(to).endsWith(target + ".toon") && /status: closed/.test(await fs.readFile(from, "utf8"))) throw Object.assign(new Error("Synthetic close IO fault"), { code: "EIO" });
  return rename(from, to);
}; syncBuiltinESMExports();`);
      const faultSavedTitle = issue.title, faultSavedState = issue.state;
      try {
        for (const command of [["linear", "sync"], ["linear", "import"], ["linear-sync", "import"]]) for (const json of [true, false]) {
          await pm.update(converted.rows[0].id, { title: "Before native fault", status: "open" });
          issue.title = "Partially persisted command"; issue.state = { name: "Completed", type: "completed" };
          const receipt = await run(mode.bin, [...prefix, ...command, "--team", "PACK", ...(json ? ["--json"] : [])], scratch,
            { ...extra, NODE_OPTIONS: `--import=${faultProgram}` }, 1);
          assert.match(receipt, /unconfirmed["\s]*:\s*1/); assert.match(receipt, /import_incomplete/);
          const item = (await pm.get(converted.rows[0].id)).item;
          assert.match(item.title!, /Partially persisted command/); assert.equal(item.status, "open"); boundaryProcessChecks++;
        }
      } finally { issue.title = faultSavedTitle; issue.state = faultSavedState; }
      await pm.create({ title: "Duplicate provenance", description: buildItemPlan(issue, {}).description, parent: "none", unset: ["goal", "objective", "sprint", "release"] });
      const beforeConflict = (await pm.listAllComplete({ includeBody: true })).items;
      for (const command of [["linear", "sync"], ["linear", "import"], ["linear-sync", "import"]]) for (const json of [true, false]) {
        const receipt = await run(mode.bin, [...prefix, ...command, "--team", "PACK", ...(json ? ["--json"] : [])], scratch, extra, 1);
        assert.match(receipt, /import_conflict/); assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, beforeConflict); boundaryProcessChecks++;
      }
      for (const json of [true, false]) {
        const plan = await run(mode.bin, [...prefix, "linear", "export", "--dry-run", ...(json ? ["--json"] : [])], scratch, mode.vars, 1);
        assert.match(plan, /import_conflict/); boundaryProcessChecks++;
      }
      results.push({ hostVersion, mode: mode.name, boundaryProcessChecks, passed: true, nativePoints: 5, declaredMinutes: 240, jsonBytes: Buffer.byteLength(raw), ownershipJsonBytes: Buffer.byteLength(ownershipRaw), ownershipUnchanged: true, legacyTerminalProjection: true, peerInterleavings: interleavings, retainedOrRetriedIdentities: 1 + restoredAliases * 2, sdkPayloadChecks: sdkContract.checks, assignmentReadbacks: sdkContract.ids.length, simulationChecks: 6, refusedProjectionChecks: 2, commands: commandCount - commandsBefore });
      process.stdout.write(`${hostVersion} ${mode.name}: passed\n`);
    }
  }
  const report = { hostVersions, artifactSha256: digest, modes: results, readOnlyProviderRequests: requests, remoteMutations: 0 };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
} finally { await new Promise<void>((done) => server.close(() => done())); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
