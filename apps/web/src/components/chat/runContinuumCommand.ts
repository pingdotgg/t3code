import type { ScopedThreadRef } from "@t3tools/contracts";
import { parseContinuumCommand } from "@t3tools/shared/continuumCommands";

import { CONTINUUM_PANEL_SURFACES } from "../../continuumCommands";
import { useRightPanelStore } from "../../rightPanelStore";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** `handled`: the command ran (or was refused with a toast) and the draft is not sent as a turn. */
export type ContinuumCommandOutcome = "not-a-command" | "send" | "handled" | "handled-keep-draft";

/** Applies Continuum skill commands before sending the turn. */
export function runContinuumCommand(input: {
  readonly prompt: string;
  readonly threadRef: ScopedThreadRef;
  readonly serverThread: boolean;
}): ContinuumCommandOutcome {
  const parsed = parseContinuumCommand(input.prompt);
  if (parsed === null || parsed.spec.kind !== "skill") return "not-a-command";
  const { spec, args } = parsed;
  const panelKind = spec.panel ? CONTINUUM_PANEL_SURFACES[spec.panel] : null;
  if (panelKind && input.serverThread) {
    useRightPanelStore.getState().open(input.threadRef, panelKind);
  }
  if (args === "" && !spec.allowsEmpty) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: `/${spec.name} needs more`,
        description: `Usage: /${spec.name} ${spec.argumentHint}`,
      }),
    );
    return "handled-keep-draft";
  }
  return args === "" && panelKind ? "handled" : "send";
}
