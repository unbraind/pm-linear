/** Prove import mirror policy and observational guard regressions fail only in disposable source copies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "linear-mirror-reverts-"));
try {
  await mkdir(join(scratch, "test"));
  await cp(join(root, "test/import-isolation-budget.test.ts"), join(scratch, "test/import-isolation-budget.test.ts"));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(root, "index.ts"), "utf8");
  const mutants = [
    { name: "import mirror reuses the observational entry limit", before: 'return readClosureItems(source, selections, projection, 65536);', after: 'return readClosureItems(source, selections, projection, 20000);' },
    { name: "observational default is accidentally widened", before: 'entryLimit = 20000', after: 'entryLimit = 65536' },
    { name: "dry-run bypasses the shared import mirror policy", before: 'const staged = await readImportMirror(root, [],', after: 'const staged = await readClosureItems(root, [],' },
    { name: "native close validation bypasses the shared import mirror policy", before: 'await readImportMirror(pmRoot, [id], async (copy) => {', after: 'await readClosureItems(pmRoot, [id], async (copy) => {' },
  ];
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, TMPDIR: tmpdir(), NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const results = [];
  for (const mutant of mutants) {
    assert.ok(original.includes(mutant.before), mutant.name);
    await writeFile(join(scratch, "index.ts"), original.replace(mutant.before, mutant.after));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/import-isolation-budget.test.ts"], { cwd: scratch, env: variables, encoding: "utf8", timeout: 1500000 });
    assert.equal(result.status, 1, `${mutant.name}: ${(result.stdout + result.stderr).slice(-1800)}`);
    assert.match(result.stdout + result.stderr, /Tracker isolation budget exceeded|AssertionError/);
    results.push({ behavior: mutant.name, passed: 0, failed: 1 });
    process.stdout.write(`proved: ${mutant.name}\n`);
  }
  await writeFile(join(scratch, "index.ts"), original);
  const fixed = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/import-isolation-budget.test.ts"], { cwd: scratch, env: variables, encoding: "utf8", timeout: 1500000 });
  assert.equal(fixed.status, 0, (fixed.stdout + fixed.stderr).slice(-2200)); assert.match(fixed.stdout, /tests 1/);
  const report = { sourceSha256: createHash("sha256").update(original).digest("hex"), mutants: results, fixed: { passed: 1, failed: 0 }, reviewedCheckoutMutated: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
