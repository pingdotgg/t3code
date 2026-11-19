import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { parseContinuumCommand } from "@t3tools/shared/continuumCommands";

import { CONTINUUM_PANEL_SURFACES } from "../../continuumCommands";
import { useRightPanelStore } from "../../rightPanelStore";
import { improveEnvironment } from "../../state/improve";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureText } from "../continuum/commandFailure";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** `handled`: the command ran (or was refused with a toast) and the draft is not sent as a turn. */
export type ContinuumCommandOutcome = "not-a-command" | "send" | "handled" | "handled-keep-draft";

function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `req_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Runs Continuum's slash commands at send time. Skills continue as a normal send (the server adds
 * their procedure); actions such as `/improve` run here instead of starting a turn.
 */
export function useContinuumCommandSend() {
  const startImprove = useAtomCommand(improveEnvironment.start, { reportFailure: false });

  return async (input: {
    readonly prompt: string;
    readonly threadRef: ScopedThreadRef;
    readonly serverThread: boolean;
    readonly modelSelection: ModelSelection;
    readonly hasAttachments: boolean;
  }): Promise<ContinuumCommandOutcome> => {
    const parsed = parseContinuumCommand(input.prompt);
    if (parsed === null) return "not-a-command";
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
    if (spec.kind === "skill") {
      // A panel skill with nothing to do yet just opens its panel.
      return args === "" && panelKind ? "handled" : "send";
    }
    if (!input.serverThread) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `/${spec.name} works in a started thread`,
          description: "Send a first message, then run it again.",
        }),
      );
      return "handled-keep-draft";
    }
    if (input.hasAttachments) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `/${spec.name} takes text only`,
          description: "Remove the attachments and context, then send it again.",
        }),
      );
      return "handled-keep-draft";
    }
    switch (spec.name) {
      case "improve": {
        const result = await startImprove({
          environmentId: input.threadRef.environmentId,
          input: {
            requestId: newRequestId(),
            sourceThreadId: input.threadRef.threadId,
            prompt: args,
            improver: input.modelSelection,
            destination: input.modelSelection,
          },
        });
        const error = commandFailureText(result, "The prompt could not be improved.");
        if (error !== null) {
          toastManager.add(
            stackedThreadToast({ type: "error", title: "/improve failed", description: error }),
          );
          return "handled-keep-draft";
        }
        return "handled";
      }
      default:
        return "send";
    }
  };
}
