import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createKompasEnvironmentAtoms } from "@t3tools/client-runtime/state/kompas";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KompasSnapshot, ThreadId, Workstream } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { useEnvironmentQuery } from "../state/query";

export const kompasEnvironment = createKompasEnvironmentAtoms(connectionAtomRuntime);

export interface Kompas {
  readonly environmentId: EnvironmentId;
  readonly snapshot: KompasSnapshot;
}

/** The machine's plugins, memory, decks and projects; null until it answered once. */
export function useKompas(): Kompas | null {
  const environmentId = usePrimaryEnvironmentId();
  const { data } = useEnvironmentQuery(
    environmentId === null ? null : kompasEnvironment.snapshotAtom(environmentId),
  );
  return environmentId === null || data === null ? null : { environmentId, snapshot: data };
}

/** Chat mode hides the coding tools. A server without Kompas keeps them. */
export function useChatMode(): boolean {
  const environmentId = usePrimaryEnvironmentId();
  const { data, error } = useEnvironmentQuery(
    environmentId === null ? null : kompasEnvironment.snapshotAtom(environmentId),
  );
  return data === null ? error === null : !data.settings.developerMode;
}

/** `useChatMode` for code outside React. */
export function readChatMode(): boolean {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) return true;
  const result = appAtomRegistry.get(kompasEnvironment.snapshotAtom(environmentId));
  const snapshot = AsyncResult.getOrElse(result, () => null);
  return snapshot === null ? !AsyncResult.isFailure(result) : !snapshot.settings.developerMode;
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
