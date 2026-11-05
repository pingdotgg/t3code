import { useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";

export function useThreadWorkspaceMenu(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): AppBarMenuItem {
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const project = projects.find((project) => project.id === thread?.projectId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const update = useAtomCommand(threadEnvironment.updateMetadata, "change thread workspace");
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const { data, error, refresh } = useEnvironmentQuery(
    requested && project
      ? vcsEnvironment.listWorktrees({ environmentId, input: { cwd: project.workspaceRoot } })
      : null,
  );
  const disabled =
    !thread ||
    !canOperate ||
    pending ||
    ["preparing", "queued", "starting", "running", "waiting"].includes(
      thread.runtime?.status ?? "idle",
    );
  const apply = (input: Parameters<typeof update>[0]["input"]) => {
    setPending(true);
    void update({ environmentId, input: { ...input, expectedIdle: true } }).finally(() =>
      setPending(false),
    );
  };
  return {
    id: "thread-workspace",
    title: "Change workspace",
    icon: "folder",
    items: [
      {
        id: "thread-projects",
        title: "Project",
        items: projects.map((target) => ({
          id: target.id,
          title: target.title,
          subtitle: target.workspaceRoot,
          selected: target.id === thread?.projectId,
          disabled,
          onPress: () => {
            if (target.id !== thread?.projectId) apply({ threadId, projectId: target.id });
          },
        })),
      },
      {
        id: "thread-worktrees",
        title: "Worktree",
        items: [
          {
            id: "load-worktrees",
            title: requested ? "Refresh worktrees" : "Load worktrees",
            disabled,
            subtitle: error ?? "Reopen this menu after loading",
            onPress: () => {
              setRequested(true);
              if (requested) refresh();
            },
          },
          ...(data?.worktrees ?? []).map((worktree) => ({
            id: worktree.path,
            title: worktree.refName ?? "Detached HEAD",
            subtitle: worktree.path,
            selected: worktree.path === (thread?.worktreePath ?? project?.workspaceRoot),
            disabled,
            onPress: () =>
              apply({
                threadId,
                branch: worktree.refName,
                worktreePath: worktree.path === project?.workspaceRoot ? null : worktree.path,
              }),
          })),
        ],
      },
    ],
  };
}
