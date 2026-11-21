import type { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { worktreeSetupStageLabel } from "@t3tools/client-runtime/contract-labels";

export type SetupLine =
  | { readonly kind: "running"; readonly text: string }
  | {
      readonly kind: "failed";
      readonly text: string;
      readonly error: string | null;
      readonly tail: ReadonlyArray<string>;
      readonly terminalId: string | null;
    };

const TAIL_LINES = 3;

/**
 * What an agent card shows of its worktree setup. T3 reports a failed setup script as a failed
 * stage while the phase is still running or done, so a failed stage shows in every phase. A
 * setup that finished clean, and a thread that has none, show nothing.
 */
export function setupLine(snapshot: WorktreeSetupSnapshot | null | undefined): SetupLine | null {
  if (snapshot == null) return null;
  const failed = snapshot.stages.find((entry) => entry.status === "failed");
  if (snapshot.phase === "failed" || failed !== undefined) {
    return {
      kind: "failed",
      text: failed === undefined ? "Setup failed" : `${worktreeSetupStageLabel(failed.id)} failed`,
      error: snapshot.error ?? failed?.detail ?? null,
      tail: failed?.tail.slice(-TAIL_LINES) ?? [],
      terminalId: snapshot.setupScript?.terminalId ?? null,
    };
  }
  if (snapshot.phase !== "running") return null;
  const stage = snapshot.stages.find((entry) => entry.status === "running");
  if (stage === undefined) return null;
  const percent = stage.percent === null ? "" : ` ${stage.percent}%`;
  return { kind: "running", text: `${worktreeSetupStageLabel(stage.id)}${percent}` };
}
