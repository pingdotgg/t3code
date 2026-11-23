import { useAtomValue } from "@effect/atom-react";
import { createKompasEnvironmentAtoms } from "@t3tools/client-runtime/state/kompas";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KompasSnapshot, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { m } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import { environmentPresentations } from "../../state/presentation";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

export const kompasEnvironment = createKompasEnvironmentAtoms(connectionAtomRuntime);

export interface Kompas {
  readonly environmentId: EnvironmentId;
  readonly snapshot: KompasSnapshot;
}

/** The first machine that answers as Kompas; others are T3 Code servers or offline. */
export const kompasAtom = Atom.make((get): Kompas | null => {
  for (const environmentId of get(environmentPresentations.presentationsAtom).keys()) {
    const result = get(kompasEnvironment.snapshotAtom(environmentId));
    const snapshot = AsyncResult.getOrElse(result, () => null);
    if (snapshot !== null) return { environmentId, snapshot };
  }
  return null;
}).pipe(Atom.withLabel("mobile:kompas"));

export const useKompas = () => useAtomValue(kompasAtom);

/** Chat mode hides the coding tabs; a phone with no Kompas machine yet shows it too. */
export const useChatMode = () => useKompas()?.snapshot.settings.developerMode !== true;

/** A new conversation's route params, or null where the machine offers no place for one. */
export const conversationDraft = ({ environmentId, snapshot }: Kompas) =>
  snapshot.chatProjectId === null
    ? null
    : {
        requestId: uuidv4(),
        environmentId: String(environmentId),
        projectId: String(snapshot.chatProjectId),
      };

/** Starts a conversation, optionally with text waiting in its composer. */
export function useStartConversation() {
  const selectDetail = useSelectWorkspaceDetail();
  return async (kompas: Kompas, prompt?: string) => {
    const draft = conversationDraft(kompas);
    const projectId = kompas.snapshot.chatProjectId;
    if (draft === null || projectId === null) return;
    if (prompt === undefined) {
      selectDetail({ name: "Thread", params: { draft } });
      return;
    }
    await waitForComposerDraftsLoaded();
    const draftId = createNewTaskDraft({ environmentId: kompas.environmentId, projectId });
    setComposerDraftText(draftId, prompt);
    selectDetail({ name: "Thread", params: { draft: { ...draft, draftId } } });
  };
}

export function useOpenThread() {
  const selectDetail = useSelectWorkspaceDetail();
  return (environmentId: EnvironmentId, threadId: ThreadId) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(environmentId), threadId: String(threadId) },
    });
}

/** Shows why a command failed; true when it succeeded. */
export function reportFailure(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      m(msg("That did not work")),
      error instanceof Error ? error.message : m(msg("An error occurred.")),
    );
  }
  return false;
}
