/** Prove both review regressions in disposable copies without mutating the reviewed checkout. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutState } from "./checkout-state.ts";

const source = resolve(import.meta.dirname, "..");
const before = checkoutState(source);
const scratch = await mkdtemp(join(tmpdir(), "linear-toolchain-review-"));
try {
  await mkdir(join(scratch, "test"));
  await mkdir(join(scratch, ".agents/pm/chores"), { recursive: true });
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  await copyFile(join(source, "test/toolchain-review.test.ts"), join(scratch, "test/toolchain-review.test.ts"));
  await copyFile(join(source, ".agents/pm/settings.json"), join(scratch, ".agents/pm/settings.json"));
  const helperPath = "test/sdk-install-command.ts";
  const itemPath = ".agents/pm/chores/pm-linear-toolchain-1104.toon";
  const helper = await readFile(join(source, helperPath), "utf8");
  const item = await readFile(join(source, itemPath), "utf8");
  const mutations = [
    {
      name: "restore direct Windows npm.cmd launch",
      file: helperPath, original: helper,
      from: 'return { command: ["npm.cmd", ...args].map((arg) => `"${arg}"`).join(" "), args: [], shell: true };',
      to: 'return { command: "npm.cmd", args, shell: false };',
    },
    {
      name: "remove Windows shell token quoting",
      file: helperPath, original: helper,
      from: '.map((arg) => `"${arg}"`)', to: "",
    },
    ...["", "--test-concurrency=1 "].map((option) => ({
      name: `remove build from ${option || "default "}linked parent-clear command`,
      file: itemPath, original: item,
      from: `npm run build && nice -n 10 node --test ${option}test/typed-parent-clear.test.ts`,
      to: `nice -n 10 node --test ${option}test/typed-parent-clear.test.ts`,
    })),
  ];
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: devNull,
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: tmpdir() };
  const command = ["--test", "--test-reporter=tap", "--test-concurrency=1", "test/toolchain-review.test.ts"];
  const results = [];
  for (const mutation of mutations) {
    await writeFile(join(scratch, helperPath), helper);
    await writeFile(join(scratch, itemPath), item);
    assert.ok(mutation.original.includes(mutation.from), mutation.name);
    await writeFile(join(scratch, mutation.file), mutation.original.replace(mutation.from, mutation.to));
    const run = spawnSync(process.execPath, command, { cwd: scratch, env: variables, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 1, `${mutation.name}: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /ERR_ASSERTION/);
    assert.match(run.stdout, /# pass 3\b/);
    assert.match(run.stdout, /# fail 1\b/);
    results.push({ mutation: mutation.name, passed: 3, failed: 1 });
  }
  await writeFile(join(scratch, helperPath), helper);
  await writeFile(join(scratch, itemPath), item);
  const fixed = spawnSync(process.execPath, command, { cwd: scratch, env: variables, encoding: "utf8", timeout: 60_000 });
  assert.equal(fixed.status, 0, `${fixed.stdout}\n${fixed.stderr}`);
  assert.match(fixed.stdout, /# pass 4\b/);
  assert.match(fixed.stdout, /# fail 0\b/);
  assert.equal(checkoutState(source), before, "the reviewed checkout must remain untouched");
  process.stdout.write(`${JSON.stringify({ reverted: results, fixed: { passed: 4, failed: 0 }, reviewedCheckoutMutated: false })}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
