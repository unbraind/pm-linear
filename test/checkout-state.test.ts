/** The revert receipts' mutation flag is only as good as the checkout fingerprint behind it. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkoutState } from "./checkout-state.ts";

/** Create a disposable Git checkout with one committed file. */
function repository(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "checkout-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => assert.equal(spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).status, 0, args.join(" "));
  git("init", "-q"); writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
  git("add", "index.ts"); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  return root;
}

test("rewriting an already modified tracked file changes the fingerprint", (t) => {
  const root = repository(t);
  writeFileSync(join(root, "index.ts"), "export const value = 2;\n");
  const before = checkoutState(root);
  writeFileSync(join(root, "index.ts"), "export const value = 3;\n");
  assert.notEqual(checkoutState(root), before, "status stays ' M index.ts', so only content can tell the runs apart");
});

test("rewriting an untracked file changes the fingerprint", (t) => {
  const root = repository(t);
  writeFileSync(join(root, "notes.txt"), "first\n");
  const before = checkoutState(root);
  writeFileSync(join(root, "notes.txt"), "second\n");
  assert.notEqual(checkoutState(root), before);
});

test("an untouched checkout keeps its fingerprint", (t) => {
  const root = repository(t);
  writeFileSync(join(root, "notes.txt"), "kept\n");
  assert.equal(checkoutState(root), checkoutState(root));
});

test("a host without a git executable falls back to the file digest", (t) => {
  const root = repository(t), path = process.env.PATH;
  t.after(() => { process.env.PATH = path; });
  process.env.PATH = join(root, "no-tools-here");
  const before = checkoutState(root);
  writeFileSync(join(root, "index.ts"), "export const value = 4;\n");
  assert.notEqual(checkoutState(root), before);
});
