import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useRef } from "react";

import { filesystemEnvironment } from "../state/filesystem";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export function useOpenWorkspaceFile(input: {
  readonly environmentId: EnvironmentId | null;
  readonly flowKey: string;
  readonly addProject: (
    workspaceRoot: string,
    options: {
      readonly workspaceFile: string;
      readonly repoRoots: ReadonlyArray<string>;
      readonly title?: string;
    },
  ) => Promise<void>;
}) {
  const { addProject, environmentId, flowKey } = input;
  const generationRef = useRef(0);
  useLayoutEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
    };
  }, [flowKey]);
  const readWorkspaceFile = useAtomQueryRunner(filesystemEnvironment.readWorkspaceFile, {
    reportFailure: false,
  });
  return useCallback(
    async (workspaceFilePath: string) => {
      if (!environmentId) return;
      const generation = generationRef.current;
      const readResult = await readWorkspaceFile({
        environmentId,
        input: { workspaceFilePath },
      });
      if (generationRef.current !== generation) return;
      if (readResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(readResult)) {
          const error = squashAtomCommandFailure(readResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to open workspace",
              description:
                error instanceof Error ? error.message : "Could not read the .code-workspace file.",
            }),
          );
        }
        return;
      }
      const resolved = readResult.value;
      const primaryRepoRoot = resolved.repoRoots[0];
      if (!primaryRepoRoot) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Workspace has no Git repositories",
            description: "Add at least one existing Git repository to the workspace file.",
          }),
        );
        return;
      }
      const missingFolders = resolved.folders.filter((folder) => !folder.exists);
      if (missingFolders.length > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Some workspace folders are missing",
            description: `${missingFolders.length} folder(s) listed in the workspace could not be found and were skipped.`,
          }),
        );
      }
      const fileName = workspaceFilePath.split(/[/\\]/).pop() ?? workspaceFilePath;
      const title = fileName.replace(/\.code-workspace$/i, "").trim();
      await addProject(primaryRepoRoot, {
        workspaceFile: resolved.workspaceFilePath,
        repoRoots: resolved.repoRoots,
        ...(title.length > 0 ? { title } : {}),
      });
    },
    [addProject, environmentId, readWorkspaceFile],
  );
}
