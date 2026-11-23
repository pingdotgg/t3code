import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isChatMode } from "@t3tools/client-runtime/state/conversation-mode";
import { createKompasEnvironmentAtoms } from "@t3tools/client-runtime/state/kompas";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KompasSnapshot, ThreadId, Workstream } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { serverEnvironment } from "../state/server";
import { chatModeRedirect } from "./settingsGroups";

export const kompasEnvironment = createKompasEnvironmentAtoms(connectionAtomRuntime);

export interface Kompas {
  readonly environmentId: EnvironmentId;
  readonly snapshot: KompasSnapshot;
}

/** Null until the machine answered once, and for a server without Kompas. */
const snapshotAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get): KompasSnapshot | null => {
    if (environmentId === null) return null;
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config?.environment.capabilities.kompas !== true) return null;
    return AsyncResult.getOrElse(get(kompasEnvironment.snapshotAtom(environmentId)), () => null);
  }),
);

const chatModeAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    isChatMode(
      environmentId === null
        ? undefined
        : get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities,
      get(snapshotAtom(environmentId)),
    ),
  ),
);

/** The primary machine's plugins, memory, decks and projects. */
export function useKompas(): Kompas | null {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useAtomValue(snapshotAtom(environmentId));
  return environmentId === null || snapshot === null ? null : { environmentId, snapshot };
}

/** Whether a machine's coding tools are hidden; the primary machine's without an id. */
export function useChatMode(environmentId?: EnvironmentId | null): boolean {
  const primary = usePrimaryEnvironmentId();
  return useAtomValue(chatModeAtom(environmentId ?? primary));
}

/** `useChatMode` for code outside React. */
export const readChatMode = (environmentId?: EnvironmentId | null): boolean =>
  appAtomRegistry.get(
    chatModeAtom(environmentId ?? appAtomRegistry.get(primaryEnvironmentIdAtom) ?? null),
  );

/** Where to go from a page chat mode hides. Waits for the machine's answer, so developer mode stays. */
export function useChatModeRedirect() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const ready = useKompas() !== null;
  const chatMode = useChatMode();
  return ready && chatMode ? chatModeRedirect(pathname) : null;
}

export function useWorkstreamOf(threadId: string | null | undefined): {
  readonly kompas: Kompas;
  readonly workstream: Workstream;
} | null {
  const kompas = useKompas();
  const workstream = kompas?.snapshot.workstreams.find(
    (entry) =>
      entry.coordinatorThreadId === threadId ||
      entry.threads.some((thread) => thread.threadId === threadId),
  );
  return kompas === null || workstream === undefined ? null : { kompas, workstream };
}

/** Starts a conversation, optionally with text waiting in its composer. */
export function useStartConversation() {
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const openDraft = useNewThreadHandler();
  return async (prompt?: string): Promise<{ readonly threadId: ThreadId } | null> => {
    const environmentId = scratchEnvironmentId(null);
    const project = environmentId === null ? null : await openScratchProject(environmentId);
    return project === null
      ? null
      : openDraft(
          scopeProjectRef(project.environmentId, project.id),
          prompt === undefined ? {} : { prompt },
        );
  };
}

/** Shows why a command failed; true when it succeeded. */
export function useReportFailure() {
  const gt = useGT();
  return (result: AtomCommandResult<unknown, unknown>): boolean => {
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("That did not work"),
        description: error instanceof Error ? error.message : gt("An error occurred."),
      });
    }
    return false;
  };
}
