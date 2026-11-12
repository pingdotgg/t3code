import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { normalizeThreadNote, type ScopedThreadRef } from "@t3tools/contracts";
import { useRef } from "react";

import { useQuietThreadProjection } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { toastManager } from "../ui/toast";

/**
 * Saves a thread note at most once per edit; blur and close can both fire for the same text.
 * `onFailure` gets the unsaved text so the caller can put it back in front of the user.
 */
export function useThreadNoteSave(
  threadRef: ScopedThreadRef,
  canEdit: boolean,
  onFailure: (text: string) => void,
) {
  const note = useQuietThreadProjection(threadRef)?.projection.thread.note ?? "";
  const setThreadNote = useOrchestrationCommand(threadEnvironment.setNote, {
    reportFailure: false,
  });
  const submittedRef = useRef<string | null | undefined>(undefined);

  const save = (text: string) => {
    if (!canEdit) return;
    const next = normalizeThreadNote(text);
    const current =
      submittedRef.current === undefined ? normalizeThreadNote(note) : submittedRef.current;
    if (next === current) return;
    submittedRef.current = next;
    void setThreadNote({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, note: next },
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      submittedRef.current = undefined;
      onFailure(text);
      toastManager.add({
        type: "error",
        title: "Failed to save thread note",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };
  const beginEdit = () => {
    submittedRef.current = undefined;
  };
  return { note, save, beginEdit };
}
