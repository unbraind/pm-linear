/** Construct the fixed SDK installation command without exposing arbitrary shell input. */

/**
 * Launch npm.cmd through the Windows shell; keep POSIX installations on direct argv.
 * Only calendar-version pins are accepted, so every quoted shell token is known data.
 */
export function sdkInstallCommand(version: string, platform: NodeJS.Platform = process.platform): {
  command: string; args: string[]; shell: boolean;
} {
  if (version.trim() !== version || !/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(version)) throw new Error("Expected a pinned SDK calendar version");
  const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@unbrained/pm-cli@${version}`];
  if (platform === "win32") {
    return { command: ["npm.cmd", ...args].map((arg) => `"${arg}"`).join(" "), args: [], shell: true };
  }
  return { command: "npm", args, shell: false };
}
