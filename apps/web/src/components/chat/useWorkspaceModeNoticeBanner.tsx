import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { FolderGit2Icon, TriangleAlertIcon } from "lucide-react";

import { useEnvironmentQuery } from "../../state/query";
import { useSelectThreadShellsForProjectRefs } from "../../state/entities";
import { vcsEnvironment } from "../../state/vcs";
import {
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
  const { projectRoot, branch, mode } = input;
  const lookupBranch = input.enabled && mode === "open" && projectRoot !== null && branch !== null;
  const branchRefQuery = useEnvironmentQuery(
    lookupBranch
      ? vcsEnvironment.listRefs({
          environmentId: input.environmentId,
          input: { cwd: projectRoot, query: branch, limit: 10 },
        })
      : null,
  );
  const branchWorktreePath =
    branchRefQuery.data?.refs.find((ref) => ref.name === branch && ref.isRemote !== true)
      ?.worktreePath ?? null;
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
    branch,
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
        title: `${notice.branch} is checked out in the project folder`,
        description: "Git can't check out one branch in two folders.",
        actions: (
          <>
            <Button size="xs" variant="ghost" onClick={() => input.onWorkspaceModeChange("switch")}>
              Work in project folder
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => input.onWorkspaceModeChange("branch-off")}
            >
              Branch off instead
            </Button>
          </>
        ),
      };
    case "joins-worktree":
      return {
        id: `workspace-mode:join:${notice.worktreePath}`,
        variant: notice.runningThreadTitle === null ? "info" : "warning",
        icon: <FolderGit2Icon />,
        title: `Opens the existing worktree for ${notice.branch}`,
        description:
          notice.runningThreadTitle === null
            ? notice.worktreePath
            : `"${notice.runningThreadTitle}" is running there and shares its files.`,
        ...(notice.runningThreadTitle === null
          ? {}
          : {
              actions: (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => input.onWorkspaceModeChange("branch-off")}
                >
                  Branch off instead
                </Button>
              ),
            }),
      };
    case "project-folder-busy":
      return {
        id: "workspace-mode:root-busy",
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: `"${notice.runningThreadTitle}" is running in the project folder`,
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => input.onWorkspaceModeChange("branch-off")}
          >
            Branch off instead
          </Button>
        ),
      };
  }
}
