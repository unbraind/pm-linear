/** Prove the point-preservation regression fails when only import provenance production is reverted. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "linear-units-revert-"));
try {
  await mkdir(join(scratch, "test"));
  await cp(join(source, "test/estimate-units.test.ts"), join(scratch, "test/estimate-units.test.ts"));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(source, "index.ts"), "utf8");
  const behavior = "tags.push(encodeLinearEstimate(issue.team, issue.estimate ?? null, estimateMapping ?? prior));";
  assert.ok(original.includes(behavior));
  await writeFile(join(scratch, "index.ts"), original.replace(behavior, "void prior; // Revert only buildItemPlan's unit provenance production."));
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const args = ["--test", "--test-concurrency=1", "--test-name-pattern=five points stay points", "test/estimate-units.test.ts"];
  const reverted = spawnSync(process.execPath, args, { cwd: scratch, encoding: "utf8", env: variables });
  assert.equal(reverted.status, 1, "Behavioral revert must fail the acceptance test");
  assert.match(reverted.stdout + reverted.stderr, /five points stay points/);
  const fixed = spawnSync(process.execPath, args, { cwd: source, encoding: "utf8", env: variables });
  assert.equal(fixed.status, 0, "The unchanged implementation must pass after the disposable revert");
  const result = { changedFunction: "buildItemPlan", reverted: { passed: 0, failed: 1 }, fixed: { passed: 1, failed: 0 }, reviewedCheckoutMutated: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
