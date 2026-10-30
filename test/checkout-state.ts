/** Measure the reviewed checkout so revert receipts report observed mutation instead of asserting it. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Fingerprint the checkout: HEAD plus every tracked change and untracked file in a Git work tree, or a digest of all
 * file paths and bytes (excluding node_modules and .git) when the checkout has no Git metadata. Compare the value
 * before and after a harness run; equal values mean the harness left the reviewed checkout untouched.
 */
export function checkoutState(root: string): string {
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true") {
    const head = git(["rev-parse", "HEAD"]), status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (head.status !== 0 || status.status !== 0) throw new Error(`Cannot read the checkout state: ${head.stderr}${status.stderr}`);
    return head.stdout + status.stdout;
  }
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(relative(root, path)).update("\0").update(readFileSync(path)).update("\0");
    }
  };
  visit(root);
  return hash.digest("hex");
}
