import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { readThreadShell, readEnvironmentSupportsSettlement } from "../../state/entities";
import { toastManager } from "../ui/toast";

export function useAgentThreadContextMenu() {
  const { settleThread, unsettleThread } = useThreadActions();
  return async (thread: EnvironmentThreadShell, position: { x: number; y: number }) => {
    const api = readLocalApi();
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const current = readThreadShell(ref);
    if (!api || !current) return;
    const settled = current.settledAt !== null;
    try {
      const action = await api.contextMenu.show(
        [
          {
            id: settled ? "unsettle" : "settle",
            label: settled ? "Un-settle chat" : "Settle chat",
            icon: settled ? "circle" : "circle-check",
            disabled: !readEnvironmentSupportsSettlement(thread.environmentId),
          },
        ],
        position,
      );
      if (!action) return;
      const result = await (action === "settle" ? settleThread(ref) : unsettleThread(ref));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        throw squashAtomCommandFailure(result);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: settled ? "Could not un-settle chat" : "Could not settle chat",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };
}
