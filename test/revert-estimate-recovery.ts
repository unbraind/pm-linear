/** Prove forward retry, foreign identity, revision and host-contract regressions in disposable copies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "linear-recovery-revert-"));
try {
  await mkdir(join(scratch, "test"));
  for (const file of ["test/estimate-units.test.ts", "test/smoke.test.ts", "manifest.json", "package.json", "package-lock.json"]) await cp(join(source, file), join(scratch, file));
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(source, "index.ts"), "utf8");
  const mutants = [
    { name: "deleted identities are adopted without explicit native restore", pattern: "historical and malformed deletion", failure: "AssertionError",
      before: "if (!before || !entry.match && (before.document !== null || before.version !== 0))",
      after: "if (!before || !entry.match && before.document !== null)" },
    { name: "an applied item is misreported as skipped after observer failure", pattern: "forward create lineages", failure: "AssertionError",
      before: 'if (outcome) { outcome.code = "import_observer_failed";',
      after: 'if (outcome) { outcome.action = "skipped"; outcome.code = "import_failed";' },
    { name: "dependent update ignores its immediate revision fence", pattern: "forward retry revalidates", failure: "AssertionError",
      before: 'current = await observeEstimateTarget(pmRoot, id);\n      if (current.revision !== expected) {',
      after: 'current = await observeEstimateTarget(pmRoot, id);\n      if (false) {' },
    { name: "fresh retry loses the earlier declared conversion", pattern: "a peer revision cannot", failure: "AssertionError",
      before: "options.estimateMapping, previousTags,", after: "options.estimateMapping, undefined," },
    { name: "missing revision silently adopts a newer native target", pattern: "missing planning revisions", failure: "requires a paired revision",
      before: "const expected = entry.match?.id ? revisions.get(id) : before?.version ? undefined : before?.revision;",
      after: "const expected = revisions.get(id) ?? before?.revision;" },
    { name: "estimate ignore bypasses the shared forward writer", pattern: "estimate ignore mappings", failure: "AssertionError",
      before: "const applied = await importEstimateBatch",
      after: 'const applied = prepared.every((entry) => !readLinearEstimate(entry.tags).contract) ? { synced: 0, created: 0, updated: 0, skipped: prepared.length, team: options.team, issues: [], importResults: [] } : await importEstimateBatch' },
    { name: "foreign unreadable history aborts independent targets", pattern: "historical and malformed deletion", failure: "invalid",
      before: "try { return await observeEstimateTarget(pmRoot, id); } catch { return undefined; }",
      after: "return await observeEstimateTarget(pmRoot, id);" },
    { name: "provider bounds incorrectly narrow SDK native identities", pattern: "forward producers and validators", failure: "estimate_input_invalid",
      before: "const before = await observeEstimateCandidate(pmRoot, id);",
      after: 'if (id.length > 128) throw new LinearEstimateRefusal("estimate_input_invalid", "Keep SDK-native identities within their native domain."); const before = await observeEstimateCandidate(pmRoot, id);' },
  ];
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const results = [];
  for (const mutant of mutants) {
    assert.ok(original.includes(mutant.before), mutant.name);
    await writeFile(join(scratch, "index.ts"), original.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${mutant.pattern}`, "test/estimate-units.test.ts"],
      { cwd: scratch, encoding: "utf8", env: variables, timeout: 600000 });
    assert.equal(run.status, 1, `${mutant.name}: behavioral revert must fail`);
    assert.ok((run.stdout + run.stderr).toLowerCase().includes(mutant.failure.toLowerCase()), `${mutant.name}: wrong failure`);
    results.push({ revertedBehavior: mutant.name, passed: 0, failed: 1 });
  }
  await writeFile(join(scratch, "index.ts"), original);
  for (const file of ["manifest.json", "package.json", "package-lock.json"]) {
    const value = JSON.parse(await readFile(join(scratch, file), "utf8")) as {
      pm_min_version?: string; peerDependencies?: Record<string, string>;
      packages?: Record<string, { peerDependencies: Record<string, string> }>;
    };
    if (file === "manifest.json") value.pm_min_version = "2026.10.4";
    else if (file === "package.json") value.peerDependencies!["@unbrained/pm-cli"] = ">=2026.10.4";
    else value.packages![""].peerDependencies["@unbrained/pm-cli"] = ">=2026.10.4";
    await writeFile(join(scratch, file), JSON.stringify(value));
  }
  const floor = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern=declared host minimum", "test/smoke.test.ts"],
    { cwd: scratch, encoding: "utf8", env: variables, timeout: 600000 });
  assert.equal(floor.status, 1); assert.ok((floor.stdout + floor.stderr).includes("the declared minimum must include guarded schema loading"));
  results.push({ revertedBehavior: "npm, manifest and lock permit the unsupported old host", passed: 0, failed: 1 });
  const fixed = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern=forward create lineages|forward retry revalidates|historical and malformed deletion|a peer revision cannot|missing planning revisions|estimate ignore mappings|forward producers and validators|declared host minimum", "test/estimate-units.test.ts", "test/smoke.test.ts"],
    { cwd: source, encoding: "utf8", env: variables, timeout: 600000 });
  assert.equal(fixed.status, 0, "Unmodified production implementation must pass");
  assert.match(fixed.stdout, /tests 8/);
  const report = { reverted: results, fixed: { passed: 8, failed: 0 }, reviewedCheckoutMutated: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
