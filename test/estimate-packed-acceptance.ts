/** Packed estimate commands across project-local, npm-global, Bun-global, npx and bunx hosts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { linearEstimateScaleRevision, type LinearEstimateReport, type LinearIssue } from "../index.ts";

const scratch = await mkdtemp(join(tmpdir(), "linear-units-packed-"));
const hostVersion = process.env.LINEAR_ACCEPTANCE_HOST_VERSION ?? "2026.10.28";
const host = `@unbrained/pm-cli@${hostVersion}`;
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
const server = http.createServer((req, res) => {
  let raw = ""; req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
  req.on("end", () => {
    const { query } = JSON.parse(raw) as { query: string };
    assert.ok(!query.trimStart().startsWith("mutation")); requests++;
    const pageInfo = { hasNextPage: false, endCursor: null };
    const data = query.includes("LinearEstimateScale") ? { teams: { nodes: [team] } } : query.includes("LinearSchema") ? {
      teams: { nodes: [{ ...team, cyclesEnabled: false, triageEnabled: false, defaultIssueState: null, states: { nodes: [{ id: "queue", ...issue.state }], pageInfo } }] }, issueLabels: { nodes: [], pageInfo },
    } : query.includes("viewer") ? { viewer: { id: "reader" } } : { issues: { nodes: [issue], pageInfo } };
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
  const local = join(scratch, "local"), global = join(scratch, "global");
  await run("npm", ["install", "--prefix", local, "--ignore-scripts", artifact, host]);
  await run("npm", ["install", "--global", "--prefix", global, "--ignore-scripts", artifact, host]);
  const bunVars = { BUN_INSTALL_GLOBAL_DIR: join(scratch, "bun-global"), BUN_INSTALL_BIN: join(scratch, "bun-bin") };
  await run("bun", ["add", "--global", "--ignore-scripts", artifact, host], scratch, bunVars);
  const modes = [
    { name: "project-local", bin: join(local, "node_modules/.bin/pm"), args: [], vars: {} },
    { name: "npm-global", bin: join(global, "bin/pm"), args: [], vars: {} },
    { name: "bun-global", bin: join(bunVars.BUN_INSTALL_BIN, "pm"), args: [], vars: bunVars },
    { name: "npx", bin: "npm", args: ["exec", "--yes", `--package=${host}`, "--", "pm"], vars: {} },
    { name: "bunx", bin: "bun", args: ["x", "--package", host, "pm"], vars: bunVars },
  ];
  const results = [];
  for (const mode of modes) {
    const tracker = join(scratch, "trackers", mode.name); const pm = new PmClient({ pmRoot: tracker, noExtensions: true, author: "fixture" }); await pm.init("packed");
    const prefix = [...mode.args, "--pm-path", tracker]; const extra = { ...mode.vars, ...network };
    await run(mode.bin, [...prefix, "package", "install", source, "--project"], scratch, mode.vars);
    await run(mode.bin, [...prefix, "linear", "sync", "--team", "PACK", "--json"], scratch, extra);
    const native = JSON.parse(await run(mode.bin, [...prefix, "linear", "estimates", "--team", "PACK", "--json"], scratch, extra)) as LinearEstimateReport;
    assert.equal(native.rows[0].points, 5); assert.equal(native.rows[0].minutes, null);
    const file = join(scratch, "mapping.json");
    await writeFile(file, JSON.stringify({ teamId: team.id, scaleRevision: linearEstimateScaleRevision(team), entries: [{ points: 5, minutes: 240 }] }));
    for (const command of [["linear", "import"], ["linear-sync", "import"]]) await run(mode.bin, [...prefix, ...command, "--team", "PACK", "--estimate-mapping", file, "--atomic", "--json"], scratch, extra);
    const raw = await run(mode.bin, [...prefix, "linear", "estimates", "--team", "PACK", "--json"], scratch, extra);
    const converted = JSON.parse(raw) as LinearEstimateReport; assert.equal(converted.rows[0].minutes, 240);
    const toon = await run(mode.bin, [...prefix, "linear", "estimates", "--team", "PACK"], scratch, extra); assert.match(toon, /converted/);
    const exported = await run(mode.bin, [...prefix, "linear", "export", "--json"], scratch, mode.vars); assert.match(exported, /"estimate":\s*5/); assert.doesNotMatch(exported, /linear-estimate:/);
    results.push({ mode: mode.name, passed: true, nativePoints: 5, declaredMinutes: 240, jsonBytes: Buffer.byteLength(raw), commands: 7 });
    process.stdout.write(`${mode.name}: passed\n`);
  }
  const report = { hostVersion, artifactSha256: digest, modes: results, readOnlyProviderRequests: requests, remoteMutations: 0 };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
} finally { await new Promise<void>((done) => server.close(() => done())); await rm(scratch, { recursive: true, force: true }); }
