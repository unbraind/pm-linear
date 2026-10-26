/** Validate immutable public corpus copies; one operand may contain a declared synthetic link overlay. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/runtime";
import { fetchLinearDependencyClosure, LinearClosureRefusal, parseProvenance } from "../index.ts";

/** Hash every file and enforce read-only scratch ownership without inspecting original trackers. */
async function snapshot(root: string): Promise<string> {
  const inside = relative(tmpdir(), root);
  assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
  const hash = createHash("sha256");
  const entries = [root, ...(await readdir(root, { recursive: true })).sort().map((name) => join(root, name))];
  for (const file of entries) {
    const info = await stat(file);
    assert.equal(info.mode & 0o222, 0, "Use read-only scratch copies");
    if (info.isFile()) { hash.update(relative(root, file)); hash.update(await readFile(file)); }
  }
  return hash.digest("hex");
}

let requests = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    const input = JSON.parse(body) as { query: string; variables: { id: string } };
    assert.ok(!/mutation|issues\(|teams\(/.test(input.query));
    requests++;
    const id = input.variables.id;
    const next = ({ a: "b", b: "c", c: "d" } as Record<string, string>)[id];
    const issue = { id, identifier: `FIXTURE-${id}`, title: `Synthetic prerequisite ${id}`, updatedAt: "2026-10-25T00:00:00Z",
      inverseRelations: { nodes: next ? [{ id: `relation-${id}`, type: "blocks", issue: { id: next }, relatedIssue: { id } }] : [],
        pageInfo: { hasNextPage: false, endCursor: null } } };
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ data: { issue } }));
  });
});
await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
const address = server.address(); assert.ok(address && typeof address !== "string");
process.env.LINEAR_API_KEY = "synthetic-key";
process.env.LINEAR_API_BASE_URL = `http://127.0.0.1:${address.port}/graphql`;
process.env.PATH = "";
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const results = [];
try {
  for (const operand of process.argv.slice(2)) {
    const root = resolve(operand);
    const before = await snapshot(root);
    // Even census reads may backfill SDK files; isolate before calling the SDK.
    const census = await mkdtemp(join(tmpdir(), "linear-census-"));
    let corpus: Awaited<ReturnType<PmClient["listAllComplete"]>>;
    try {
      await cp(root, census, { recursive: true });
      await chmod(census, 0o700);
      for (const entry of await readdir(census, { recursive: true, withFileTypes: true })) {
        await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600);
      }
      const pm = new PmClient({ pmRoot: census, noExtensions: true });
      corpus = await pm.listAllComplete({ includeBody: true });
    } finally { await rm(census, { recursive: true, force: true }); }
    const linked = corpus.items.filter((row) => parseProvenance(row.description));
    const offset = requests;
    if (!linked.length) {
      await assert.rejects(fetchLinearDependencyClosure({ items: [corpus.items[0].id] }, root),
        (error: unknown) => error instanceof LinearClosureRefusal && error.code === "selection_required");
      results.push({ source: "public-original", items: corpus.count, linked: 0, refusal: "selection_required",
        requests: requests - offset, sourceSha256: before, unchanged: before === await snapshot(root) });
    } else {
      const report = await fetchLinearDependencyClosure({ items: [linked[0].id] }, root);
      assert.equal(report.complete, true);
      assert.deepEqual(report.frontier, ["b", "c", "d"]);
      assert.equal(requests - offset, report.measured.requests);
      results.push({ source: "public-derived-synthetic-link", items: corpus.count, linked: linked.length,
        ...report.measured, frontier: report.frontier.length, complete: report.complete,
        jsonBytes: Buffer.byteLength(JSON.stringify(report)), sourceSha256: before,
        unchanged: before === await snapshot(root) });
    }
  }
  assert.ok(results.length > 0 && results.every((row) => row.unchanged));
  process.stdout.write(`${JSON.stringify({ provider: "synthetic read-only HTTP fixture", liveLinearValidated: false, results }, null, 2)}\n`);
} finally { await new Promise<void>((done) => { server.close(() => done()); }); }
