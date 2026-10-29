/** Prove retry ownership, revision pairing and published host-contract regressions in disposable copies. */
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
    { name: "every retained history is foreign", pattern: "compensated create lineages", failure: "Missing expected rejection",
      before: "const foreign = !entry.match && (before.document !== null || before.version !== 0 && restoreVersion === undefined);",
      after: "const foreign = !entry.match && (before.document !== null || before.version !== 0);" },
    { name: "only the first birth can be compensated", pattern: "compensated create lineages", failure: "compensates the entire batch",
      before: "else if (!before.document && owned.version > before.version && latest.document)",
      after: "else if (owned.version === 1 && latest.document)" },
    { name: "dependent update ignores a peer after restore", pattern: "recovery revalidates", failure: "after_restore",
      before: "if (current.revision !== owned.revision)", after: "if (false)" },
    { name: "recovery loses the historical declared conversion", pattern: "compensated create lineages", failure: "SDK state tags",
      before: "previousTags = historical.document.metadata.tags;", after: "previousTags = undefined;" },
    { name: "newer tombstone revision authorizes an older plan", pattern: "peer rollback cannot", failure: "changed tombstone revision",
      before: "const expected = entry.match?.id ? revisions.get(entry.match.id) : before.version ? revisions.get(id) : before.revision;",
      after: "const expected = entry.match?.id ? revisions.get(entry.match.id) : before.revision;" },
    { name: "estimate ignore bypasses the guarded writer", pattern: "estimate ignore mappings", failure: "Missing expected rejection",
      before: "if (prepared.some((entry) => scaleAwareIds.has(entry.linearId)))",
      after: "if (prepared.some((entry) => readLinearEstimate(entry.tags).contract))" },
    { name: "foreign unreadable history aborts independent targets", pattern: "foreign and malformed compensation", failure: "invalid JSON",
      before: "try { return await observeEstimateTarget(pmRoot, id); } catch { return undefined; }",
      after: "return await observeEstimateTarget(pmRoot, id);" },
    { name: "rollback validation narrows native IDs to the provider-ID domain", pattern: "rollback producers and validators", failure: "estimate_input_invalid",
      before: 'format: { kind: "literal", value: "pm-linear/estimate-rollback/1" }, id: { kind: "string", max: 1024 }, linearId: closureId,',
      after: 'format: { kind: "literal", value: "pm-linear/estimate-rollback/1" }, id: closureId, linearId: closureId,' },
  ];
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const results = [];
  for (const mutant of mutants) {
    assert.ok(original.includes(mutant.before), mutant.name);
    await writeFile(join(scratch, "index.ts"), original.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${mutant.pattern}`, "test/estimate-units.test.ts"],
      { cwd: scratch, encoding: "utf8", env: variables, timeout: 600000 });
    assert.equal(run.status, 1, `${mutant.name}: behavioral revert must fail`);
    assert.ok((run.stdout + run.stderr).includes(mutant.failure), `${mutant.name}: wrong failure`);
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
  const fixed = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern=compensated create lineages|recovery revalidates|foreign and malformed compensation|peer rollback cannot|estimate ignore mappings|rollback producers and validators|declared host minimum", "test/estimate-units.test.ts", "test/smoke.test.ts"],
    { cwd: source, encoding: "utf8", env: variables, timeout: 600000 });
  assert.equal(fixed.status, 0, "Unmodified production implementation must pass");
  assert.match(fixed.stdout, /tests 7/);
  const report = { reverted: results, fixed: { passed: 7, failed: 0 }, reviewedCheckoutMutated: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
