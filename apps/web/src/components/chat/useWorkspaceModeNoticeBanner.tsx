import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { FolderGit2Icon, TriangleAlertIcon } from "lucide-react";
import { useGT } from "gt-react";

import { useEnvironmentQuery } from "../../state/query";
import { useSelectThreadShellsForProjectRefs } from "../../state/entities";
import { vcsEnvironment } from "../../state/vcs";
import {
  deriveLocalBranchNameFromRemoteRef,
  findRunningThreadTitle,
  resolveWorkspaceModeFolder,
  resolveWorkspaceModeNotice,
  type WorkspaceMode,
} from "../BranchToolbar.logic";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const NO_PROJECT_REFS: ReadonlyArray<ScopedProjectRef> = [];

/** Explains what a new thread's workspace mode will do with the picked branch before sending. */
export function useWorkspaceModeNoticeBanner(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectRef: ScopedProjectRef | null;
  readonly projectRoot: string | null;
  readonly threadId: string;
  readonly mode: WorkspaceMode;
  readonly branch: string | null;
  readonly onWorkspaceModeChange: (mode: WorkspaceMode) => void;
}): ComposerBannerStackItem | null {
  const gt = useGT();
  const { projectRoot, branch, mode } = input;
  const lookupBranch = input.enabled && mode === "open" && projectRoot !== null && branch !== null;
  // The server opens the local branch for a remote ref, so look that one up.
  const localBranch = branch === null ? null : deriveLocalBranchNameFromRemoteRef(branch);
  const branchRefQuery = useEnvironmentQuery(
    lookupBranch && localBranch !== null
      ? vcsEnvironment.listRefs({
          environmentId: input.environmentId,
          // Only local names containing this one can come first, so one page holds it in practice.
          input: { cwd: projectRoot, refKind: "local", query: localBranch, limit: 100 },
        })
      : null,
  );
  const localRefs = branchRefQuery.data?.refs ?? [];
  const branchRef =
    localRefs.find((ref) => ref.name === branch) ??
    localRefs.find((ref) => ref.name === localBranch);
  const branchWorktreePath = branchRef?.worktreePath ?? null;
  const folder =
    input.enabled && projectRoot !== null
      ? resolveWorkspaceModeFolder({ mode, projectRoot, branchWorktreePath })
      : undefined;
  const runningThreadTitle = useSelectThreadShellsForProjectRefs(
    folder === undefined || input.projectRef === null ? NO_PROJECT_REFS : [input.projectRef],
    (threads) =>
      folder === undefined || projectRoot === null
        ? null
        : findRunningThreadTitle({
            threads,
            folder,
            projectRoot,
            currentThreadId: input.threadId,
          }),
  );
  if (!input.enabled || projectRoot === null) return null;
  const notice = resolveWorkspaceModeNotice({
    mode,
    branch: branchRef?.name ?? branch,
    branchWorktreePath,
    projectRoot,
    runningThreadTitle,
  });
  if (notice === null) return null;

  switch (notice.kind) {
    case "branch-in-project-folder":
      return {
        id: `workspace-mode:root:${notice.branch}`,
        variant: "error",
        icon: <TriangleAlertIcon />,
        title: gt("{branch} is checked out in the project folder", { branch: notice.branch }),
        description: gt("Git can't check out one branch in two folders."),
        actions: (
          <>
            <Button size="xs" variant="ghost" onClick={() => input.onWorkspaceModeChange("switch")}>
              {gt("Work in project folder")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => input.onWorkspaceModeChange("branch-off")}
            >
              {gt("Branch off instead")}
            </Button>
          </>
        ),
      };
    case "joins-worktree":
      return {
        id: `workspace-mode:join:${notice.worktreePath}`,
        variant: notice.runningThreadTitle === null ? "info" : "warning",
        icon: <FolderGit2Icon />,
        title: gt("Opens the existing worktree for {branch}", { branch: notice.branch }),
        description:
          notice.runningThreadTitle === null
            ? notice.worktreePath
            : gt('"{title}" is running there and shares its files.', {
                title: notice.runningThreadTitle,
              }),
        ...(notice.runningThreadTitle === null
          ? {}
          : {
              actions: (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => input.onWorkspaceModeChange("branch-off")}
                >
                  {gt("Branch off instead")}
                </Button>
              ),
            }),
      };
    case "project-folder-busy":
      return {
        id: "workspace-mode:root-busy",
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: gt('"{title}" is running in the project folder', {
          title: notice.runningThreadTitle,
        }),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => input.onWorkspaceModeChange("branch-off")}
          >
            {gt("Branch off instead")}
          </Button>
        ),
      };
  }
}
