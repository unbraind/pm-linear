/** SDK-owned status normalization and lifecycle options shared by every state-model writer. */
import { isTerminalStatus, normalizeStatusInput, readSettings, resolveRuntimeStatusRegistry, type PmClientFullMutationOptions } from "@unbrained/pm-cli/sdk";

/** Produce native lifecycle input without comparing raw aliases or repeating a transition. */
export async function referenceLifecycle(root: string, current: { status?: unknown; close_reason?: unknown } | undefined,
  desired: string, assignee: string | undefined, reason: string): Promise<PmClientFullMutationOptions & { unset: string[] }> {
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  const status = normalizeStatusInput(desired, registry);
  if (!status) throw new Error("Reference status is not registered");
  const previous = typeof current?.status === "string" ? normalizeStatusInput(current.status, registry) : undefined;
  // The registry's primary lifecycle routes release assignment. Persist their
  // native result instead of reassigning and force-closing on every replay.
  const assignment = status === registry.close_status || status === registry.canceled_status ? undefined : assignee;
  return { ...(previous !== status ? { status, ...(isTerminalStatus(status, registry) ? { closeReason: String(current?.close_reason ?? reason) } : {}) } : {}),
    ...(assignment ? { assignee: assignment } : {}), unset: assignment ? [] : ["assignee"] };
}
