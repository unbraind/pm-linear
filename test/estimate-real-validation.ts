/** Inspect an immutable public tracker archive in a read-only non-git scratch directory. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { inspectLinearEstimates, type LinearEstimateTeam } from "../index.ts";

const root = await mkdtemp(join(tmpdir(), "linear-units-public-"));
const repository = process.argv[2]; const output = process.argv[3];
assert.ok(repository && output);
const revision = execFileSync("git", ["-C", repository, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
const archive = execFileSync("git", ["-C", repository, "archive", "origin/main", ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 });
execFileSync("tar", ["-x", "-C", root], { input: archive });
const tracker = join(root, ".agents/pm");
/** Hash names and contents, including all persisted indexes and histories. */
async function digest() {
  const hash = createHash("sha256"); let files = 0, bytes = 0;
  const entries = await readdir(tracker, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((entry) => entry.isFile()).sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
    const file = join(entry.parentPath, entry.name); const value = await readFile(file); files++; bytes += value.length;
    hash.update(relative(tracker, file)).update(value);
  }
  return { sha256: hash.digest("hex"), files, bytes };
}
const prior = { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES };
try {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  // chmod follows symbolic links, so refuse them before any permission change (the inspection guard runs later).
  const link = entries.find((entry) => entry.isSymbolicLink());
  if (link) throw new Error(`Validation archive contains a symbolic link (${relative(root, join(link.parentPath, link.name))}); refusing before changing permissions.`);
  for (const entry of entries) await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o555 : 0o444);
  await chmod(root, 0o555);
  process.env.PATH = ""; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  const before = await digest();
  const team: LinearEstimateTeam = { id: "validation-team", key: "AUDIT", issueEstimationType: "fibonacci", issueEstimationAllowZero: false, issueEstimationExtended: false };
  const baseline = await inspectLinearEstimates({ team, limit: 20 }, tracker);
  const changed = await inspectLinearEstimates({ team: { ...team, issueEstimationExtended: true }, limit: 100 }, tracker);
  assert.ok(baseline.counts.scanned > 0);
  const after = await digest(); assert.deepEqual(after, before);
  await writeFile(output, JSON.stringify({ repository: "unbraind/pm-linear", revision, nonGit: true, gitExecutableAvailable: false, readOnly: true,
    source: before, sourceUnchanged: true, inspections: 2, counts: baseline.counts, changedScaleCounts: changed.counts,
    jsonBytes: Buffer.byteLength(JSON.stringify(baseline)), nativeProviderCoverage: baseline.counts.matched,
    limitation: "This public tracker contains no owned unit contracts unless matched is nonzero; conversion and invalidation acceptance is separately measured on synthetic real-SDK trackers." }, null, 2) + "\n");
} finally {
  for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isDirectory()) await chmod(join(entry.parentPath, entry.name), 0o700);
  await rm(root, { recursive: true, force: true });
}
