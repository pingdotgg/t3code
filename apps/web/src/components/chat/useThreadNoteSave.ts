import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { normalizeThreadNote, type ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";

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
  const editGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const baselineRef = useRef(normalizeThreadNote(note));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates asynchronous save recovery when this thread's editor unmounts
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      editGenerationRef.current += 1;
    };
  }, []);

  const save = (text: string) => {
    if (!canEdit) return;
    const next = normalizeThreadNote(text);
    const current =
      submittedRef.current === undefined ? normalizeThreadNote(note) : submittedRef.current;
    if (next === current || (submittedRef.current === undefined && next === baselineRef.current))
      return;
    submittedRef.current = next;
    const editGeneration = editGenerationRef.current;
    void setThreadNote({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, note: next },
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result) || !mountedRef.current)
        return;
      const error = squashAtomCommandFailure(result);
      if (submittedRef.current === next) submittedRef.current = undefined;
      if (editGeneration === editGenerationRef.current) onFailure(text);
      toastManager.add({
        type: "error",
        title: m(msg("Failed to save thread note")),
        description: error instanceof Error ? error.message : m(msg("An error occurred.")),
      });
    });
  };
  const beginEdit = () => {
    editGenerationRef.current += 1;
    submittedRef.current = undefined;
    baselineRef.current = normalizeThreadNote(note);
  };
  const changeDraft = () => {
    editGenerationRef.current += 1;
  };
  return { note, save, beginEdit, changeDraft };
}
