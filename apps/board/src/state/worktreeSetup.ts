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

/** What an agent card shows of its worktree setup. A finished setup, and a thread that has none, show nothing. */
export function setupLine(snapshot: WorktreeSetupSnapshot | null | undefined): SetupLine | null {
  if (snapshot == null) return null;
  if (snapshot.phase === "running") {
    const stage = snapshot.stages.find((entry) => entry.status === "running");
    if (stage === undefined) return null;
    const percent = stage.percent === null ? "" : ` ${stage.percent}%`;
    return { kind: "running", text: `${worktreeSetupStageLabel(stage.id)}${percent}` };
  }
  if (snapshot.phase !== "failed") return null;
  const stage = snapshot.stages.find((entry) => entry.status === "failed");
  return {
    kind: "failed",
    text: stage === undefined ? "Setup failed" : `${worktreeSetupStageLabel(stage.id)} failed`,
    error: snapshot.error,
    tail: stage?.tail.slice(-TAIL_LINES) ?? [],
    terminalId: snapshot.setupScript?.terminalId ?? null,
  };
}
