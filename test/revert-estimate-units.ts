/** Prove the point-preservation regression fails when only import provenance production is reverted. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutState } from "./checkout-state.ts";

const source = resolve(import.meta.dirname, "..");
const checkoutBefore = checkoutState(source);
const scratch = await mkdtemp(join(tmpdir(), "linear-units-revert-"));
try {
  await mkdir(join(scratch, "test"));
  await cp(join(source, "test/native-reference.ts"), join(scratch, "test/native-reference.ts"));
  await cp(join(source, "test/estimate-units.test.ts"), join(scratch, "test/estimate-units.test.ts"));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(source, "index.ts"), "utf8");
  const behavior = "tags.push(encodeLinearEstimate(issue.team, issue.estimate ?? null, estimateMapping ?? prior));";
  assert.ok(original.includes(behavior));
  await writeFile(join(scratch, "index.ts"), original.replace(behavior, "void prior; // Revert only buildItemPlan's unit provenance production."));
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const args = ["--test", "--test-reporter=spec", "--test-concurrency=1", "--test-name-pattern=five points stay points", "test/estimate-units.test.ts"];
  const reverted = spawnSync(process.execPath, args, { cwd: scratch, encoding: "utf8", env: variables });
  assert.equal(reverted.status, 1, "Behavioral revert must fail the acceptance test");
  assert.match(reverted.stdout + reverted.stderr, /five points stay points/);
  // The reverted plan encodes no estimate contract, so the selected test reads points from a missing row.
  assert.match(reverted.stdout + reverted.stderr, /Cannot read properties of undefined \(reading ['"]points['"]\)/);
  const fixed = spawnSync(process.execPath, args, { cwd: source, encoding: "utf8", env: variables });
  assert.equal(fixed.status, 0, "The unchanged implementation must pass after the disposable revert");
  assert.match(fixed.stdout, /^ℹ tests 1$/m, "Exactly the selected test runs in the fixed checkout");
  const reviewedCheckoutMutated = checkoutState(source) !== checkoutBefore;
  assert.equal(reviewedCheckoutMutated, false, "The harness must not change the reviewed checkout.");
  const result = { changedFunction: "buildItemPlan", reverted: { passed: 0, failed: 1 }, fixed: { passed: 1, failed: 0 }, reviewedCheckoutMutated };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
