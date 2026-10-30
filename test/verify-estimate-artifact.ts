/** Verify the acceptance artifact's exact shipped files and detect ignored-file mutation in an owned copy. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expected = JSON.parse(await readFile(process.argv[2] ?? "docs/estimate-packed-validation.json", "utf8")) as { artifactSha256: string };
const scratch = await mkdtemp(join(tmpdir(), "linear-artifact-verify-"));
const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
try {
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "dist/index.js"], { cwd: root, env: variables, encoding: "utf8" });
  assert.equal(ignored.status, 0, "Run artifact verification in the package checkout; dist/index.js must remain ignored.");
  /** Digest the checkout's planned shipped files and its git status, so the receipt measures checkout mutation. */
  async function checkoutDigest(files: readonly string[]): Promise<string> {
    const hash = createHash("sha256");
    for (const file of [...files].sort()) hash.update(file).update("\0").update(await readFile(join(root, file))).update("\0");
    const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, env: variables, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    return hash.update(status.stdout).digest("hex");
  }
  // npm pack runs prepack (npm run build) in this checkout: plan the file set without scripts, then compare before/after.
  const planned = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, env: variables, encoding: "utf8", timeout: 300000 });
  assert.equal(planned.status, 0, planned.stderr);
  const plannedFiles = (JSON.parse(planned.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((file) => file.path);
  const checkoutBefore = await checkoutDigest(plannedFiles);
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: root, env: variables, encoding: "utf8", timeout: 300000 });
  assert.equal(packed.status, 0, packed.stderr);
  const [receipt] = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const artifact = join(scratch, receipt.filename);
  const artifactSha256 = createHash("sha256").update(await readFile(artifact)).digest("hex");
  assert.equal(artifactSha256, expected.artifactSha256, "The re-captured bytes must equal the exact artifact used by all consumer layouts.");
  const unpacked = spawnSync("tar", ["-xzf", artifact, "-C", scratch], { env: variables, encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  assert.ok(receipt.files.some((file) => file.path === "dist/index.js"));
  assert.ok(receipt.files.every((file) => !file.path.startsWith("/") && !file.path.split("/").includes("..")));
  /** Compare archive contents with the current complete shipped file set, including ignored build output. */
  async function matchesCurrent(): Promise<boolean> {
    for (const file of receipt.files) {
      const current = await readFile(join(root, file.path));
      const extracted = await readFile(join(scratch, "package", file.path));
      if (!current.equals(extracted)) return false;
    }
    return true;
  }
  assert.equal(await matchesCurrent(), true, "Every shipped file must match the validated archive.");
  const target = join(scratch, "package", "dist/index.js"), original = await readFile(target);
  try {
    await writeFile(target, Buffer.concat([original, Buffer.from("\n// synthetic ignored shipped-file mutation\n")]));
    assert.equal(await matchesCurrent(), false, "Changing an ignored shipped file must invalidate the receipt.");
  } finally { await writeFile(target, original); }
  assert.equal(await matchesCurrent(), true, "Restoring the owned copy must restore the exact artifact image.");
  assert.equal(createHash("sha256").update(await readFile(artifact)).digest("hex"), artifactSha256);
  const reviewedCheckoutMutated = (await checkoutDigest(plannedFiles)) !== checkoutBefore;
  assert.equal(reviewedCheckoutMutated, false, "npm pack, including its prepack build, must not change the checkout's shipped files or git status.");
  const report = { artifactSha256, shippedFiles: receipt.files.length, allCurrentShippedFilesMatch: true,
    mutatedIgnoredCopyRejected: true, restoredCopyMatches: true, reviewedCheckoutMutated };
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
