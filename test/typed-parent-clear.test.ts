/** Run parent-clear behavior against both declared host contracts and the built artifact. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "./typed-parent-clear-cases.ts";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8")) as { pm_min_version: string };
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
assert.equal(pkg.peerDependencies["@unbrained/pm-cli"], `>=${manifest.pm_min_version}`);
const hostVersions = [...new Set([manifest.pm_min_version, pkg.devDependencies["@unbrained/pm-cli"]])];

for (const hostVersion of hostVersions) {
  test(`typed parent clear: installed SDK ${hostVersion} preserves both create routes`, async (t) => {
    assert.match(hostVersion, /^\d{4}\.\d{1,2}\.\d{1,2}$/);
    const root = await mkdtemp(join(tmpdir(), "linear-parent-host-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const vars = {
      PATH: process.env.PATH ?? "", LANG: "C.UTF-8", HOME: join(root, "home"),
      NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null",
      NPM_CONFIG_CACHE: join(tmpdir(), "linear-parent-host-cache"),
      GIT_CEILING_DIRECTORIES: tmpdir(), PM_AUTHOR: "fixture",
    };
    await mkdir(vars.HOME);
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const installed = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@unbrained/pm-cli@${hostVersion}`],
      { cwd: root, env: vars, encoding: "utf8", timeout: 180_000 });
    assert.equal(installed.status, 0, `SDK ${hostVersion} install: ${installed.error?.message ?? installed.stderr}`);
    const host = JSON.parse(await readFile(join(root, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { version: string };
    assert.equal(host.version, hostVersion, "the consumer must resolve the requested SDK version");
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "test"));
    await copyFile(new URL("../dist/index.js", import.meta.url), join(root, "dist/index.js"));
    await copyFile(new URL("./typed-parent-clear-cases.ts", import.meta.url), join(root, "test/typed-parent-clear-cases.ts"));
    const result = spawnSync(process.execPath,
      ["--test", "--test-reporter=tap", "--test-concurrency=1", "test/typed-parent-clear-cases.ts"],
      { cwd: root, env: vars, encoding: "utf8", timeout: 180_000 });
    assert.equal(result.status, 0, `SDK ${hostVersion} consumer: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# pass 2\b/);
    assert.match(result.stdout, /# fail 0\b/);
    t.diagnostic(`SDK ${hostVersion}: forward and shared-plan parent-clear regressions passed (2/2), using isolated non-git trackers`);
  });
}
