import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { AsyncResult } from "effect/unstable/reactivity";
import { createRef, useEffect, useMemo } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData, optimisticFileAtom } from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    return {
      change: (contents: string) => coordinatorRef.current?.change(contents),
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          persist: async (nextContents) => {
            const atom = optimisticFileAtom(environmentId, cwd, relativePath);
            const pendingDraft = appAtomRegistry.get(atom);
            if (!pendingDraft) return AsyncResult.success({ relativePath });
            const expectedContents = pendingDraft.expectedContents;
            const result = await writeFile({
              environmentId,
              input: {
                cwd,
                relativePath,
                contents: nextContents,
                ...(expectedContents !== undefined ? { expectedContents } : {}),
              },
            });
            if (result._tag !== "Success") {
              const pending = appAtomRegistry.get(atom);
              const cause = squashAtomCommandFailure(result);
              if (pending)
                appAtomRegistry.set(atom, {
                  ...pending,
                  saveError:
                    cause instanceof Error
                      ? cause.message
                      : "Saving failed. Your edits are retained.",
                });
            }
            return result;
          },
          onConfirmed: (confirmedContents) => {
            confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
          },
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [cwd, environmentId, onPendingChange, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}
