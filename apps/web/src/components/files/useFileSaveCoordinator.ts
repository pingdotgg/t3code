import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { createRef, useEffect, useMemo } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getProjectFileQueryAtom,
  getProjectFileQueryData,
} from "./projectFilesQueryState";

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
            // Debouncing and disposal can outlive the read that authorized the edit.
            const atom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
            if (appAtomRegistry.get(atom).waiting) {
              await executeAtomQuery(appAtomRegistry, atom, {
                reportFailure: false,
                reportDefect: false,
              });
            }
            const file = getProjectFileQueryData(environmentId, cwd, relativePath);
            if (!file || file.truncated) {
              return AsyncResult.fail(new Error("Cannot save an incomplete file preview."));
            }
            return writeFile({
              environmentId,
              input: { cwd, relativePath, contents: nextContents },
            });
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
