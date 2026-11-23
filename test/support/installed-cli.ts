import { execFile } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/** Install the built extension in an owned fixture tracker and return its CLI runner. */
export async function installLinearCli(root: string) {
  const source = join(root, "package-source");
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  await mkdir(source);
  await cp(resolve("dist"), join(source, "dist"), { recursive: true });
  await cp(resolve("manifest.json"), join(source, "manifest.json"));
  const exec = promisify(execFile);

  /** Dispatch with an isolated home and only the supplied synthetic provider credentials. */
  function run(args: string[], provider: { key?: string; url?: string } = {}) {
    return exec(process.execPath, [cli, "--pm-path", root, ...args], {
      cwd: root,
      timeout: 60_000,
      env: {
        HOME: join(root, "test-home"),
        PATH: root,
        PM_AUTHOR: "fixture",
        GIT_CEILING_DIRECTORIES: tmpdir(),
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        LINEAR_API_KEY: provider.key,
        LINEAR_API_BASE_URL: provider.url,
      },
    });
  }

  await run(["package", "install", source, "--project"]);
  return run;
}
