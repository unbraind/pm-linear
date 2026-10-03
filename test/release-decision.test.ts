import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/** Exercise the actual workflow decision in a disposable Git project. */
test("a merged but untagged release keeps its committed version on retry", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-linear-release-decision-"));
  const project = join(root, "project");
  const remote = join(root, "remote.git");
  const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
  const block = /      - name: Decide release\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/.exec(workflow)?.[1];
  assert.ok(block, "the release decision must be present");
  const script = block.split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");

  /** Run a command against the fixture and fail with its diagnostic. */
  function run(command: string, args: string[], cwd = project): string {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** Capture the workflow's machine-readable decision without publishing anything. */
  function decide(repositoryName = "pm-linear"): Record<string, string> {
    const output = join(root, "output");
    const summary = join(root, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const result = spawnSync("bash", ["-c", script], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RELEASE_TIMEZONE: "Europe/Vienna", GITHUB_REPOSITORY: `unbraind/${repositoryName}` },
    });
    assert.equal(result.status, 0, `release decision failed: ${result.stderr}`);
    return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  }

  /** Assert the decision stops before writing release outputs on an unsafe state. */
  function refuse(message: RegExp, repositoryName = "pm-linear"): void {
    const output = join(root, "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", script], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(root, "summary"), RELEASE_TIMEZONE: "Europe/Vienna", GITHUB_REPOSITORY: `unbraind/${repositoryName}` },
    });
    assert.notEqual(result.status, 0, "an unsafe release state must fail closed");
    assert.match(result.stdout, message);
    assert.equal(readFileSync(output, "utf8"), "", "no release outputs may escape a refused decision");
  }

  try {
    run("git", ["init", "-b", "main", project], root);
    run("git", ["config", "user.email", "fixture@example.invalid"]);
    run("git", ["config", "user.name", "Release fixture"]);
    writeFileSync(join(project, "package.json"), '{"name":"pm-linear","version":"2000.1.1"}\n');
    writeFileSync(join(project, "source.txt"), "first\n");
    run("git", ["add", "."]);
    run("git", ["commit", "-m", "Initial release"]);
    run("git", ["tag", "-a", "v2000.01.01", "-m", "Initial production-style release"]);
    assert.equal(run("git", ["cat-file", "-t", "v2000.01.01"]), "tag", "production release tags are annotated");
    run("git", ["init", "--bare", remote], root);
    run("git", ["remote", "add", "origin", remote]);
    run("git", ["push", "origin", "main", "--tags"]);

    writeFileSync(join(project, "source.txt"), "second\n");
    run("git", ["add", "source.txt"]);
    run("git", ["commit", "-m", "Add a feature"]);
    const fresh = decide();
    assert.equal(fresh.should_release, "true");
    assert.notEqual(fresh.npm_version, "2000.1.1", "new work should get a new version");

    writeFileSync(join(project, "package.json"), '{"name":"pm-linear","version":"2000.1.2"}\n');
    run("git", ["add", "package.json"]);
    run("git", ["commit", "-m", "Release pm-linear v2000.01.02"]);
    const retry = decide();
    assert.equal(retry.should_release, "true");
    assert.equal(retry.tag, "v2000.01.02");
    assert.equal(retry.latest_tag, "v2000.01.01", "the retry selects the annotated mainline tag");
    assert.equal(retry.npm_version, "2000.1.2");
    assert.equal(retry.base_sha, run("git", ["rev-parse", "HEAD"]));

    const releaseHead = run("git", ["rev-parse", "HEAD"]);
    writeFileSync(join(project, "package.json"), '{"name":"pm-linear","version":"2000.1.2","dependencies":{"fixture":"1.0.0"}}\n');
    run("git", ["add", "package.json"]);
    run("git", ["commit", "-m", "Update dependencies after failed publication"]);
    refuse(/without a recognized release commit/);
    run("git", ["reset", "--hard", releaseHead]);

    run("git", ["commit", "--amend", "-m", "Release pm-linear.fork v2000.01.02"]);
    const renamedRetry = decide("pm-linear.fork");
    assert.equal(renamedRetry.latest_tag, "v2000.01.01");
    assert.equal(renamedRetry.tag, "v2000.01.02");
    assert.equal(renamedRetry.npm_version, "2000.1.2");
    refuse(/without a recognized release commit/, "pm-linearXfork");
    run("git", ["reset", "--hard", releaseHead]);

    const unrelatedCommit = run("git", ["commit-tree", run("git", ["rev-parse", "HEAD^{tree}"]), "-m", "Unrelated release"]);
    const conflictingTag = spawnSync("git", ["tag", "-a", "v2000.01.02", "-m", "Conflicting release tag", unrelatedCommit], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, GIT_COMMITTER_DATE: "2000-01-02T00:00:00Z" },
    });
    assert.equal(conflictingTag.status, 0, conflictingTag.stderr);
    refuse(/already exists/);
    run("git", ["tag", "-d", "v2000.01.02"]);

    writeFileSync(join(project, "source.txt"), "third\n");
    run("git", ["add", "source.txt"]);
    run("git", ["commit", "-m", "Document the failed release"]);
    refuse(/main advanced past release commit/);

    writeFileSync(join(project, "package.json"), '{"name":"pm-linear","version":"2000.1.3"}\n');
    run("git", ["add", "package.json"]);
    run("git", ["commit", "-m", "Release pm-linear v2000.01.02"]);
    refuse(/disagrees with package.json version/);

    writeFileSync(join(project, "package.json"), '{"name":"pm-linear","version":"2000.1.4"}\n');
    run("git", ["add", "package.json"]);
    run("git", ["commit", "-m", "Manually change the package version"]);
    refuse(/without a recognized release commit/);

    const initialCommit = run("git", ["rev-list", "--max-parents=0", "HEAD"]);
    const futureDatedOldTag = spawnSync("git", ["tag", "-a", "v1999.01.01", "-m", "Old release with a future tagger date", initialCommit], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, GIT_COMMITTER_DATE: "2099-01-01T00:00:00Z" },
    });
    assert.equal(futureDatedOldTag.status, 0, futureDatedOldTag.stderr);
    run("git", ["tag", "v2000.01.04"]);
    writeFileSync(join(project, "source.txt"), "fourth\n");
    run("git", ["add", "source.txt"]);
    run("git", ["commit", "-m", "Add another feature"]);
    assert.equal(run("git", ["tag", "--sort=-creatordate"]).split("\n")[0], "v1999.01.01");
    const afterClockSkew = decide();
    assert.equal(afterClockSkew.latest_tag, "v2000.01.04", "choose the nearest reachable release tag, not the newest tagger clock");
    assert.equal(afterClockSkew.should_release, "true");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
