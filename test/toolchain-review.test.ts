/** Regressions for the PR208 installation command and reproducible tracker evidence. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { locateItem, readLocatedItem, readSettings } from "@unbrained/pm-cli/sdk";
import { sdkInstallCommand } from "./sdk-install-command.ts";

test("SDK install command quotes every Windows shell token and launches npm.cmd through a shell", () => {
  assert.deepEqual(sdkInstallCommand("2026.11.4", "win32"), {
    command: '"npm.cmd" "install" "--ignore-scripts" "--no-audit" "--no-fund" "@unbrained/pm-cli@2026.11.4"',
    args: [], shell: true,
  });
});

test("SDK install command preserves direct npm argv on POSIX", () => {
  for (const platform of ["linux", "darwin"] as const) {
    assert.deepEqual(sdkInstallCommand("2026.10.24", platform), {
      command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "@unbrained/pm-cli@2026.10.24"], shell: false,
    });
  }
});

test("SDK install command refuses non-pin shell input before constructing a command", () => {
  for (const version of ["", "latest", "2026.11.4\n", '2026.11.4" & echo injected', "2026.11.4%PATH%", "2026.11.4!PATH!"]) {
    for (const platform of ["win32", "linux"] as const) assert.throws(() => sdkInstallCommand(version, platform), /pinned SDK calendar version/);
  }
});

test("every linked parent-clear command builds the artifact before running its consumer", async () => {
  const root = fileURLToPath(new URL("../.agents/pm", import.meta.url));
  const located = await locateItem(root, "pm-linear-toolchain-1104");
  assert.ok(located);
  const { document } = await readLocatedItem(located, { schema: (await readSettings(root)).schema });
  const commands = (document.metadata.tests ?? []).map((entry) => entry.command ?? "")
    .filter((command) => command.includes("test/typed-parent-clear.test.ts"));
  assert.ok(commands.length >= 2, "both independently recorded commands must stay covered");
  for (const command of commands) assert.match(command, /^npm run build && nice -n 10 node --test\b.*test\/typed-parent-clear\.test\.ts$/);
});
