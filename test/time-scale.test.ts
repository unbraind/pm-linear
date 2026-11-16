import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";

/** Import the scale helper in a child so the evaluated env is fully controlled. */
const program = `import { testTime } from ${JSON.stringify(new URL("./support/time.ts", import.meta.url).href)}; process.stdout.write(String(testTime(120000)));`;

/** Run the helper import with one scale setting; undefined deletes the variable. */
function importWithScale(scale: string | undefined): SpawnSyncReturns<string> {
  const env = { ...process.env };
  if (scale === undefined) delete env.PM_TEST_TIME_SCALE;
  else env.PM_TEST_TIME_SCALE = scale;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], { encoding: "utf8", timeout: 30000, env });
}

test("an empty PM_TEST_TIME_SCALE behaves as unset instead of refusing every import", () => {
  for (const unset of [undefined, "", "  "]) {
    const result = importWithScale(unset);
    assert.equal(result.status, 0, `the setting ${JSON.stringify(unset)} must import cleanly:\n${result.stderr}`);
    assert.equal(result.stdout, "120000", `the setting ${JSON.stringify(unset)} must default to scale 1`);
  }
});

test("a valid scale still applies and every non-empty invalid setting still refuses import", () => {
  const doubled = importWithScale("2");
  assert.equal(doubled.status, 0, doubled.stderr);
  assert.equal(doubled.stdout, "240000", "scale 2 doubles harness budgets");
  for (const invalid of ["0", "-1", "abc", "NaN", "Infinity"]) {
    const result = importWithScale(invalid);
    assert.notEqual(result.status, 0, `the setting ${JSON.stringify(invalid)} must still be rejected`);
    assert.match(result.stderr, /PM_TEST_TIME_SCALE must be finite and positive/);
  }
});
