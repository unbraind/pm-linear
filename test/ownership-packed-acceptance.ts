/** Exercise the packed command through five isolated package-manager host topologies. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { buildItemPlan, type LinearIssue, type LinearOwnershipReport } from "../index.ts";

const scratch = await mkdtemp(join(tmpdir(), "linear-packed-"));
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const bunBin = process.env.LINEAR_ACCEPTANCE_BUN ?? "bun";
const baseEnv = { ...process.env, HOME: join(scratch, "home"), NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", NPM_CONFIG_CACHE: join(tmpdir(), "linear-ownership-acceptance-cache"), GIT_CEILING_DIRECTORIES: tmpdir() };
await mkdir(baseEnv.HOME, { recursive: true });
/** Capture subprocess output privately and report only failure categories or bounded CLI receipts. */
async function run(bin: string, args: string[], cwd = scratch, additions: Record<string, string> = {}, expectedExit = 0) {
  return new Promise<string>((done, fail) => {
    const child = spawn(bin, args, { cwd, env: { ...baseEnv, ...additions }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", fail);
    child.on("exit", (code) => { if (code === expectedExit) done(out || err); else fail(new Error(`Packed acceptance command ${args[0]} failed (${code}): ${err.slice(-600)}`)); });
  });
}
const provider: LinearIssue & { updatedAt: string } = { id: "remote", identifier: "PACK-1", title: "Packed acceptance", description: "Synthetic", priority: 2,
  state: { name: "Queue", type: "unstarted" }, labels: { nodes: [], pageInfo: { hasNextPage: false } } as LinearIssue["labels"],
  dueDate: null, cycle: { name: null }, updatedAt: "2026-10-27T00:00:00Z" };
let requests = 0;
let malformedEnvelope = false;
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => { assert.ok(!body.includes("mutation")); requests++; res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify(malformedEnvelope ? null : { data: { issue: provider } })); });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const addr = server.address(); assert.ok(addr && typeof addr !== "string");
const network = { LINEAR_API_KEY: "synthetic-key", LINEAR_API_BASE_URL: `http://127.0.0.1:${addr.port}/graphql` };
try {
  process.stdout.write("packing candidate\n");
  const pack = JSON.parse(await run(npmBin, ["pack", "--json", "--pack-destination", scratch], resolve(import.meta.dirname, ".."))) as Array<{ filename: string }>;
  const tarball = join(scratch, pack[0].filename);
  await run("tar", ["-xzf", tarball, "-C", scratch]);
  const source = join(scratch, "package");
  const local = join(scratch, "local");
  process.stdout.write("installing project-local host\n");
  await run(npmBin, ["install", "--prefix", local, "--ignore-scripts", tarball, "@unbrained/pm-cli@2026.10.20"]);
  const global = join(scratch, "npm-global");
  process.stdout.write("installing npm-global host\n");
  await run(npmBin, ["install", "--global", "--prefix", global, "--ignore-scripts", tarball, "@unbrained/pm-cli@2026.10.20"]);
  const bunEnv = { BUN_INSTALL_GLOBAL_DIR: join(scratch, "bun-global"), BUN_INSTALL_BIN: join(scratch, "bun-bin") };
  process.stdout.write("installing bun-global host\n");
  await run(bunBin, ["add", "--global", "--ignore-scripts", tarball, "@unbrained/pm-cli@2026.10.20"], scratch, bunEnv);
  const modes = [
    { name: "project-local", bin: join(local, "node_modules/.bin/pm"), args: [], vars: {} },
    { name: "npm-global", bin: join(global, "bin/pm"), args: [], vars: {} },
    { name: "bun-global", bin: join(bunEnv.BUN_INSTALL_BIN, "pm"), args: [], vars: bunEnv },
    { name: "npx", bin: npmBin, args: ["exec", "--yes", "--package=@unbrained/pm-cli@2026.10.20", "--", "pm"], vars: {} },
    { name: "bunx", bin: bunBin, args: ["x", "--package", "@unbrained/pm-cli@2026.10.20", "pm"], vars: bunEnv },
  ];
  const results = [];
  for (const mode of modes) {
    provider.state = { name: "Queue", type: "unstarted" };
    malformedEnvelope = false;
    const tracker = join(scratch, "trackers", mode.name);
    await mkdir(tracker, { recursive: true });
    const pm = new PmClient({ pmRoot: tracker, noExtensions: true, author: "fixture" });
    await pm.init("packed");
    const plan = buildItemPlan(provider, {});
    const created = await pm.create({ ...plan, tags: plan.tags.join(","), parent: "none", unset: ["goal", "objective", "sprint", "release"], createMode: "progressive" });
    await run(mode.bin, [...mode.args, "--pm-path", tracker, "package", "install", source, "--project"], scratch, mode.vars);
    const offset = requests;
    const raw = await run(mode.bin, [...mode.args, "--pm-path", tracker, "linear", "ownership", "--item", created.item.id, "--json"], scratch, { ...mode.vars, ...network });
    const output = JSON.parse(raw) as LinearOwnershipReport;
    assert.equal(output.ok, true, mode.name); assert.equal(output.atomicCrossSystem, false); assert.equal(output.counts.unknown, 8); assert.equal(requests - offset, 2);
    const file = join(tracker, "acknowledged.json");
    await writeFile(file, JSON.stringify(output.observation));
    await pm.update(created.item.id, { status: "in_progress", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
    provider.state = { name: "Blocked", type: "unstarted" };
    const args = [...mode.args, "--pm-path", tracker, "linear", "ownership", "--item", created.item.id, "--base", file];
    const conflict = JSON.parse(await run(mode.bin, [...args, "--json"], scratch, { ...mode.vars, ...network })) as LinearOwnershipReport;
    assert.equal(conflict.fields.find((field) => field.field === "status")?.decision, "conflict");
    const toon = await run(mode.bin, args, scratch, { ...mode.vars, ...network });
    assert.match(toon, /conflict/);
    const title = output.observation.fields.find((row) => row.field === "title")!;
    await writeFile(file, JSON.stringify({ ...output.observation, fields: [title, { ...title, local: "invalid" }] }));
    const duplicate = JSON.parse(await run(mode.bin, [...args, "--json"], scratch, { ...mode.vars, ...network })) as LinearOwnershipReport;
    assert.equal(duplicate.fields.find((field) => field.field === "title")?.decision, "unknown_base");
    malformedEnvelope = true;
    const error = JSON.parse(await run(mode.bin, [...mode.args, "--pm-path", tracker, "linear", "ownership", "--item", created.item.id, "--json"], scratch, { ...mode.vars, ...network }, 2)) as { code: string; field: string };
    assert.equal(error.code, "source_invalid"); assert.equal(error.field, "response");
    // Shared transport refusals must retain their category through every packed host dispatcher.
    let sourceDispatches = 0;
    for (const command of [
      ["linear", "schema", "--team", "ENG"], ["linear", "capture", "--item", created.item.id, "--thread", "root"],
      ["linear", "closure", "--items", created.item.id], ["linear", "sync", "--team", "ENG", "--atomic", "--dry-run"],
      ["linear", "import", "--team", "ENG", "--atomic", "--dry-run"],
      ["linear-sync", "import", "--team", "ENG", "--atomic", "--dry-run"], ["linear", "export", "--team", "ENG", "--push"],
    ]) {
      for (const format of [["--json"], []]) {
        const rawError = await run(mode.bin, [...mode.args, "--pm-path", tracker, ...command, ...format], scratch, { ...mode.vars, ...network }, 2);
        assert.match(rawError, /source_invalid/); assert.match(rawError, /response/);
        if (format.length) { const receipt = JSON.parse(rawError) as { code: string; field: string }; assert.equal(receipt.code, "source_invalid"); assert.equal(receipt.field, "response"); }
        sourceDispatches++;
      }
    }
    results.push({ mode: mode.name, passed: true, requests: requests - offset, jsonBytes: Buffer.byteLength(raw),
      nullableCycle: true, statusConflict: true, malformedDuplicate: true, typedEnvelope: true, sourceDispatches, toon: true });
    process.stdout.write(`${mode.name}: passed\n`);
  }
  const report = { packageVersion: JSON.parse(await readFile(join(source, "package.json"), "utf8")).version as string, hostVersion: "2026.10.20", modes: results };
  if (process.argv[2]) {
    await writeFile(resolve(process.argv[2]), `${JSON.stringify(report, null, 2)}\n`);
  }
} finally {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(scratch, { recursive: true, force: true });
}
