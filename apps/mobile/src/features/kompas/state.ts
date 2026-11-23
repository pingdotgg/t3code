import { useAtomValue } from "@effect/atom-react";
import { isChatMode } from "@t3tools/client-runtime/state/conversation-mode";
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
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
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

/** Null until the machine answered once, and for a server without Kompas. */
const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): KompasSnapshot | null => {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config?.environment.capabilities.kompas !== true) return null;
    return AsyncResult.getOrElse(get(kompasEnvironment.snapshotAtom(environmentId)), () => null);
  }),
);

/** The first machine that answers as Kompas; others are T3 Code servers or offline. */
export const kompasAtom = Atom.make((get): Kompas | null => {
  for (const environmentId of get(environmentPresentations.presentationsAtom).keys()) {
    const snapshot = get(snapshotAtom(environmentId));
    if (snapshot !== null) return { environmentId, snapshot };
  }
  return null;
}).pipe(Atom.withLabel("mobile:kompas"));

const environmentChatModeAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    environmentId === null
      ? true
      : isChatMode(
          get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities,
          get(snapshotAtom(environmentId)),
        ),
  ),
);

/** The whole app's mode: a machine with its coding tools on shows them. */
const chatModeAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom).keys()].every((environmentId) =>
    get(environmentChatModeAtom(environmentId)),
  ),
).pipe(Atom.withLabel("mobile:chat-mode"));

export const useKompas = () => useAtomValue(kompasAtom);

/** Whether the app hides its coding tabs. */
export const useChatMode = () => useAtomValue(chatModeAtom);

/** Whether one machine's threads hide their coding tools. */
export const useEnvironmentChatMode = (environmentId: EnvironmentId | null) =>
  useAtomValue(environmentChatModeAtom(environmentId));

export const readEnvironmentChatMode = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentChatModeAtom(environmentId));

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
