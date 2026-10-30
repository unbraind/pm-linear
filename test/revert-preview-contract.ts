/** Behavioral projection, simulation and lifecycle-oracle reverts in disposable non-git copies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutState } from "./checkout-state.ts";
const source = resolve(import.meta.dirname, "..");
const checkoutBefore = checkoutState(source);
const scratch = await mkdtemp(join(tmpdir(), "linear-preview-contract-"));
try {
  await mkdir(join(scratch, "test"));
  for (const name of ["ownership.test.ts", "estimate-units.test.ts", "native-reference.ts"]) await cp(join(source, "test", name), join(scratch, "test", name));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(source, "index.ts"), "utf8");
  const reference = await readFile(join(source, "test/native-reference.ts"), "utf8");
  const mutants = [
    { name: "ownership certifies skipped coordinator state", file: "index.ts", before: "if (result.importMode) {", after: "if (false) {", pattern: "projection refuses" },
    { name: "owned projection retains read-only history files", file: "index.ts", before: 'else if (entry.isFile() && ((await lstat(join(entry.parentPath, entry.name))).mode & 0o200) === 0) await chmod(join(entry.parentPath, entry.name), 0o600);', after: '', pattern: "read-only tracker projections" },
    ...[0, 1, 2].map((occurrence) => ({ name: `import route ${occurrence} drops simulation mode`, file: "index.ts", before: "dryRun: Boolean(result.dryRun)", after: "dryRun: false", occurrence, pattern: "every simulated" })),
    { name: "empty provider pages drop simulation mode", file: "index.ts", before: 'unconfirmed: 0, ...(options.dryRun ? { dryRun: true, prepared: [] } : {})', after: 'unconfirmed: 0', pattern: "every simulated" },
    { name: "reference compares raw hyphenated status names", file: "test/native-reference.ts", before: "const status = normalizeStatusInput(desired, registry);", after: "const status = desired;", pattern: "model oracle" },
    { name: "reference repeats unchanged native transitions", file: "test/native-reference.ts", before: "previous !== status", after: "true", pattern: "model oracle" },
    { name: "reference omits registry terminal close reason", file: "test/native-reference.ts", before: "isTerminalStatus(status, registry)", after: "false", pattern: "model oracle" },
  ];
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const results = [];
  for (const mutant of mutants) {
    await writeFile(join(scratch, "index.ts"), original);
    await writeFile(join(scratch, "test/native-reference.ts"), reference);
    const before = mutant.file === "index.ts" ? original : reference;
    let offset = -1;
    for (let index = 0; index <= ("occurrence" in mutant ? mutant.occurrence : 0); index++) offset = before.indexOf(mutant.before, offset + 1);
    assert.ok(offset >= 0, mutant.name);
    await writeFile(join(scratch, mutant.file), before.slice(0, offset) + mutant.after + before.slice(offset + mutant.before.length));
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${mutant.pattern}`, "test/ownership.test.ts", "test/estimate-units.test.ts"], { cwd: scratch, env: variables, encoding: "utf8", timeout: 600000 });
    assert.equal(run.status, 1, `${mutant.name}: must fail behaviorally`);
    assert.match(run.stdout + run.stderr, /AssertionError/);
    results.push({ revertedBehavior: mutant.name, passed: 0, failed: 1 });
  }
  await writeFile(join(scratch, "index.ts"), original);
  await writeFile(join(scratch, "test/native-reference.ts"), reference);
  const fixed = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern=projection refuses|every simulated|model oracle|read-only tracker projections", "test/ownership.test.ts", "test/estimate-units.test.ts"], { cwd: scratch, env: variables, encoding: "utf8", timeout: 600000 });
  assert.equal(fixed.status, 0, (fixed.stdout + fixed.stderr).slice(-2000));
  assert.match(fixed.stdout, /tests 4/);
  const reviewedCheckoutMutated = checkoutState(source) !== checkoutBefore;
  assert.equal(reviewedCheckoutMutated, false, "The harness must not change the reviewed checkout.");
  const report = { reverted: results, fixed: { passed: 4, failed: 0 }, reviewedCheckoutMutated };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
