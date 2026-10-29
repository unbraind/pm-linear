/** Packed estimate commands across project-local, npm-global, Bun-global, npx and bunx hosts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { buildItemPlan, encodeLinearEstimate, linearEstimateScaleRevision, syncLinearIssues, itemToLinearPayload, type LinearEstimateReport, type LinearOwnershipReport, type LinearIssue } from "../index.ts";

const scratch = await mkdtemp(join(tmpdir(), "linear-units-packed-"));
const requestedHostVersion = process.env.LINEAR_ACCEPTANCE_HOST_VERSION ?? "2026.10.28";
const vars = { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", HOME: join(scratch, "home"), NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", NPM_CONFIG_CACHE: join(tmpdir(), "linear-estimate-acceptance-cache"), GIT_CEILING_DIRECTORIES: tmpdir() };
await mkdir(vars.HOME);
/** Commands inherit only explicit noncredential configuration and synthetic provider credentials. */
async function run(bin: string, args: string[], cwd = scratch, extra: Record<string, string> = {}) {
  return new Promise<string>((done, fail) => {
    const child = spawn(bin, args, { cwd, env: { ...vars, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.on("error", fail);
    child.on("exit", (code) => code === 0 ? done(output || error) : fail(new Error(`Packed ${args[0]} failed (${code}): ${error.slice(-800)}`)));
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
      teams: { nodes: [{ ...team, cyclesEnabled: false, triageEnabled: false, defaultIssueState: null, states: { nodes: [{ id: "queue", ...issue.state }], pageInfo } }] }, issueLabels: { nodes: [], pageInfo },
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
      const tracker = join(hostRoot, "trackers", mode.name); const pm = new PmClient({ pmRoot: tracker, noExtensions: true, author: "fixture" }); await pm.init("packed");
      await assert.rejects(syncLinearIssues({ team: "PACK", limit: 10, atomic: true }, tracker, {
        fetchIssues: async () => [issue], onEstimateBoundary: async (stage) => { if (stage === "after_write") throw new Error("Packed seed rollback"); },
      }), /Packed seed rollback/);
      const prefix = [...mode.args, "--pm-path", tracker]; const extra = { ...mode.vars, ...network };
      await run(mode.bin, [...prefix, "package", "install", source, "--project"], scratch, mode.vars);
      const restored = JSON.parse(await run(mode.bin, [...prefix, "linear", "sync", "--team", "PACK", "--json"], scratch, extra)) as { created: number; skipped: number };
      assert.equal(restored.created, 1); assert.equal(restored.skipped, 0, "the packed sync restores a compensated identity");
      const native = JSON.parse(await run(mode.bin, [...prefix, "linear", "estimates", "--team", "PACK", "--json"], scratch, extra)) as LinearEstimateReport;
      assert.equal(native.rows[0].points, 5); assert.equal(native.rows[0].minutes, null);
      const file = join(scratch, "mapping.json");
      await writeFile(file, JSON.stringify({ teamId: team.id, scaleRevision: linearEstimateScaleRevision(team), entries: [{ points: 5, minutes: 240 }] }));
      for (const command of [["linear", "import"], ["linear-sync", "import"]]) await run(mode.bin, [...prefix, ...command, "--team", "PACK", "--estimate-mapping", file, "--atomic", "--json"], scratch, extra);
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
        const receipt = await run(mode.bin, [...prefix, ...command, "--team", "PACK", ...(json ? ["--json"] : ["--atomic"])], scratch, extra);
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
        await assert.rejects(syncLinearIssues({ team: "PACK", limit: 10, atomic: true, estimateMapping: conversion }, retryRoot, {
          fetchIssues: async () => values, onEstimateBoundary: async (stage, id) => { if (stage === "after_write" && id.endsWith("-z")) throw new Error("Packed batch rollback"); },
        }), /Packed batch rollback/);
        assert.equal((await retryClient.listAllComplete()).items.length, 0);
        const retryPrefix = [...mode.args, "--pm-path", retryRoot];
        await run(mode.bin, [...retryPrefix, "package", "install", source, "--project"], scratch, mode.vars);
        try {
          recoveryIssues = values.map((value) => ({ ...value, title: " Fresh replay ", description: " Fresh\r\nbody " }));
          const receipt = JSON.parse(await run(mode.bin, [...retryPrefix, importer, "import", "--team", "PACK", "--atomic", "--json"], scratch, extra)) as { created: number; skipped: number };
          assert.equal(receipt.created, 2); assert.equal(receipt.skipped, 0);
          const units = JSON.parse(await run(mode.bin, [...retryPrefix, "linear", "estimates", "--team", "PACK", "--json"], scratch, extra)) as LinearEstimateReport;
          assert.equal(units.counts.matched, 2); assert.ok(units.rows.every((row) => row.points === 5 && row.minutes === 240), "retry retains the earlier explicit mapping");
          const replay = await run(mode.bin, [...retryPrefix, importer, "import", "--team", "PACK", "--atomic"], scratch, extra);
          assert.match(replay, /skipped: 0/); assert.doesNotMatch(replay, /foreign|superseded/);
          const exported = JSON.parse(await run(mode.bin, [...retryPrefix, "linear", "export", "--json"], scratch, mode.vars)) as { payloads: Array<{ linearId: string; title: string; estimate: number; description: string }> };
          const referenceRoot = join(hostRoot, "reference", mode.name, importer);
          const reference = new PmClient({ pmRoot: referenceRoot, noExtensions: true, author: "fixture" }); await reference.init("reference");
          assert.equal(exported.payloads.length, 2);
          const byProviderId = new Map(exported.payloads.map((row) => [row.linearId, row]));
          assert.equal(byProviderId.size, 2);
          for (const value of recoveryIssues) {
            const plan = buildItemPlan(value, {}, {}, undefined, conversion);
            const created = await reference.create({ ...plan, tags: JSON.stringify(plan.tags), parent: "none", unset: ["goal", "objective", "sprint", "release"] });
            const expected = itemToLinearPayload((await reference.get(created.item.id, { depth: "deep" })).item);
            const actual = byProviderId.get(value.id); assert.ok(actual);
            for (const field of ["title", "description", "estimate"] as const) assert.deepEqual(actual[field], expected[field], "packed replay equals SDK-normalized reference");
          }
          restoredAliases++;
        } finally { recoveryIssues = undefined; }
      }
      results.push({ hostVersion, mode: mode.name, passed: true, nativePoints: 5, declaredMinutes: 240, jsonBytes: Buffer.byteLength(raw), ownershipJsonBytes: Buffer.byteLength(ownershipRaw), ownershipUnchanged: true, legacyTerminalProjection: true, peerInterleavings: interleavings, restoredIdentities: 1 + restoredAliases * 2, commands: 31 });
      process.stdout.write(`${hostVersion} ${mode.name}: passed\n`);
    }
  }
  const report = { hostVersions, artifactSha256: digest, modes: results, readOnlyProviderRequests: requests, remoteMutations: 0 };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
} finally { await new Promise<void>((done) => server.close(() => done())); await rm(scratch, { recursive: true, force: true }); }
