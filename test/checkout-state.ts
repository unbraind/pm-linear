/** Measure the reviewed checkout so revert receipts report observed mutation instead of asserting it. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Fingerprint the checkout. In a Git work tree: HEAD, the status, the bytes of every tracked change (`git diff HEAD
 * --binary`) and the path and bytes of every untracked, non-ignored file, so rewriting an already modified file still
 * changes the value. Ignored build and runtime output is out of scope. Without Git (no metadata or no executable):
 * a digest of all file paths and bytes, excluding node_modules and .git. Equal values before and after a harness run
 * mean the harness left the reviewed checkout untouched.
 */
export function checkoutState(root: string): string {
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "buffer", maxBuffer: 1 << 30 });
  if (git(["rev-parse", "--is-inside-work-tree"]).stdout?.toString().trim() === "true") {
    const reads = [["rev-parse", "HEAD"], ["status", "--porcelain=v1", "-z", "--untracked-files=all"], ["diff", "HEAD", "--binary"], ["ls-files", "-z", "--others", "--exclude-standard"]].map(git);
    const failed = reads.find((read) => read.status !== 0);
    if (failed) throw new Error(`Cannot read the checkout state: ${failed.stderr?.toString() ?? failed.error?.message}`);
    const hash = createHash("sha256");
    for (const read of reads.slice(0, 3)) hash.update(read.stdout).update("\0");
    for (const path of reads[3].stdout.toString().split("\0").filter(Boolean).sort()) hash.update(path).update("\0").update(readFileSync(join(root, path))).update("\0");
    return hash.digest("hex");
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
