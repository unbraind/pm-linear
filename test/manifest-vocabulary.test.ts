import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk";

const repoRoot = resolve(import.meta.dirname, "..");

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { devDependencies?: Record<string, string> };
const extensionManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "manifest.json"), "utf8"),
) as Record<string, unknown>;

/**
 * pm-cli's extension-manifest vocabulary is a closed set of 18 top-level keys
 * (name, version, entry, priority, description, author, capabilities,
 * manifest_version, pm_min_version, pm_max_version, engines, trusted,
 * provenance, sandbox_profile, permissions, activation, contributions,
 * legacy_capability_aliases). Since pm-cli 2026.8.19 the host reports any key
 * outside that set as a `manifest_unknown_key` finding. This manifest carried a
 * leftover top-level `"pm": {"compatibility": "v2"}` block that nothing in this
 * repository ever read — an inert relic of an older nesting convention — and
 * under the stricter CLI it turned every strict-assertion check on findings
 * into a two-code failure instead of one. That is exactly how unbraind/pm-linear
 * PRs #75 and #76 broke: their tests expected `["pm_min_version_unmet"]` but
 * got `["manifest_unknown_key", "pm_min_version_unmet"]`. The inert key is now
 * gone; this guard fails if any unrecognized key ever creeps back in.
 */
test("the extension manifest uses only keys the pm CLI recognizes", () => {
  const pin = packageJson.devDependencies?.["@unbrained/pm-cli"] ?? "";
  assert.match(pin, /^\d+\.\d+\.\d+$/, "the pinned CLI version must be an exact three-part version");
  const result = checkExtensionManifestCompatibility(extensionManifest, { pmVersion: pin });
  const unknownKeyFindings = result.findings.filter((finding) => finding.code === "manifest_unknown_key");
  assert.deepStrictEqual(
    unknownKeyFindings,
    [],
    `manifest.json carries keys outside the closed manifest vocabulary: ${unknownKeyFindings.map((f) => f.path).join(", ")}`,
  );
});
