/** Public-corpus acceptance with declared synthetic provider/link overlays and immutable read phases. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { chmod, cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { buildItemPlan, LinearOwnershipRefusal, previewLinearOwnership, type LinearIssue } from "../index.ts";
import { referenceLifecycle } from "./native-reference.ts";

/** Change modes only on a test-owned copy. */
async function modes(root: string, writable: boolean) {
  await chmod(root, writable ? 0o700 : 0o555);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? writable ? 0o700 : 0o555 : writable ? 0o600 : 0o444);
}

/** Hash names and bytes and require every source entry to be immutable. */
async function snapshot(root: string) {
  const hash = createHash("sha256");
  assert.equal((await stat(root)).mode & 0o777, 0o555);
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of files.sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
    const path = join(entry.parentPath, entry.name);
    assert.equal((await stat(path)).mode & 0o777, entry.isDirectory() ? 0o555 : 0o444);
    if (entry.isFile()) { hash.update(relative(root, path)); hash.update(await readFile(path)); }
  }
  return hash.digest("hex");
}


const root = resolve(process.argv[2] ?? "");
const inside = relative(tmpdir(), root);
assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside), "Use an immutable public tracker copy in a non-git temporary directory");
const before = await snapshot(root);
const scratch = await mkdtemp(join(tmpdir(), "linear-ownership-validation-"));
const derived = join(scratch, "derived");
const census = join(scratch, "census");
let requests = 0;
const provider: LinearIssue & { updatedAt: string } = {
  id: "synthetic-observation", identifier: "AUDIT-1", title: "Synthetic linked observation", description: "Read-only provider fixture", priority: 2,
  state: { name: "Queue", type: "unstarted" }, labels: { nodes: [], pageInfo: { hasNextPage: false } } as LinearIssue["labels"],
  dueDate: null, cycle: null, assignee: null, project: null, customer: null, estimate: null,
  url: "https://linear.app/issue/AUDIT-1", updatedAt: "2026-10-27T00:00:00Z",
};
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    assert.ok(!body.includes("mutation")); requests++;
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ data: { issue: provider } }));
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const addr = server.address(); assert.ok(addr && typeof addr !== "string");
process.env.LINEAR_API_KEY = "synthetic-key";
process.env.LINEAR_API_BASE_URL = `http://127.0.0.1:${addr.port}/graphql`;
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
process.env.PATH = "";
try {
  await cp(root, census, { recursive: true }); await modes(census, true);
  const pm = new PmClient({ pmRoot: census, noExtensions: true, author: "fixture" });
  const corpus = await pm.listAllComplete({ includeBody: true });
  const selected = corpus.items[0].id;
  await assert.rejects(previewLinearOwnership({ item: selected }, root), (error: unknown) => error instanceof LinearOwnershipRefusal && error.code === "selection_required");
  assert.equal(requests, 0);
  await cp(root, derived, { recursive: true }); await modes(derived, true);
  const overlay = new PmClient({ pmRoot: derived, noExtensions: true, author: "fixture" });
  const plan = buildItemPlan(provider, {});
  const { status, assignee, ...fields } = plan;
  const lifecycle = await referenceLifecycle(derived, (await overlay.get(selected, { depth: "deep" })).item, status, assignee, "Synthetic validation overlay");
  await overlay.update(selected, { ...fields, tags: JSON.stringify(plan.tags), ...lifecycle, unset: ["deadline", ...lifecycle.unset] });
  await modes(derived, false);
  const initial = await snapshot(derived);
  const baseline = await previewLinearOwnership({ item: selected }, derived);
  assert.equal(await snapshot(derived), initial);
  await modes(derived, true); await overlay.update(selected, { title: "Local overlay edit" }); await modes(derived, false);
  provider.priority = 1;
  const frozen = await snapshot(derived);
  const start = performance.now();
  const report = await previewLinearOwnership({ item: selected, base: baseline.observation }, derived);
  const elapsedMs = Math.round(performance.now() - start);
  assert.equal(report.disjoint, true);
  assert.equal(report.counts.local, 1); assert.equal(report.counts.provider, 1);
  provider.title = "Provider overlay edit";
  const conflicts = await previewLinearOwnership({ item: selected, base: baseline.observation }, derived);
  assert.equal(conflicts.counts.conflicts, 1);
  assert.equal(await snapshot(derived), frozen); assert.equal(await snapshot(root), before);
  process.stdout.write(`${JSON.stringify({ source: "unbraind/pm-linear origin/main public tracker", provider: "synthetic HTTP read fixture", liveLinearValidated: false,
    originalItems: corpus.count, originalRequests: 0, originalRefusal: "selection_required", syntheticOverlayItems: 1,
    fields: report.fields.length, disjoint: report.disjoint, counts: report.counts, sameFieldConflicts: conflicts.counts.conflicts,
    requests, jsonBytes: Buffer.byteLength(JSON.stringify(report)), elapsedMs, originalSha256: before, originalUnchanged: true, derivedUnchangedDuringPreviews: true }, null, 2)}\n`);
} finally {
  await new Promise<void>((done) => server.close(() => done()));
  await modes(scratch, true); await rm(scratch, { recursive: true, force: true });
}
