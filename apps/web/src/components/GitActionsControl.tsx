import {
  type GitRunStackedActionResult,
  type GitStackedAction,
  type GitStatusResult,
  type NativeApi,
} from "@t3tools/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, CloudUploadIcon, GitCommitIcon } from "lucide-react";
import { GitHubIcon } from "./Icons";
import { Button } from "~/components/ui/button";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";

interface GitActionsControlProps {
  api: NativeApi | undefined;
  gitCwd: string | null;
}

type GitActionIconName = "commit" | "push" | "pr";

interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "run_action" | "open_pr";
  action?: GitStackedAction;
}

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHubIcon />;
}

function describeGitResult(result: GitRunStackedActionResult): string {
  const parts: string[] = [];

  if (result.commit.status === "created") {
    parts.push(result.commit.subject ?? "Committed changes");
  }

  if (result.push.status === "pushed") {
    parts.push(
      result.push.upstreamBranch
        ? `Pushed to ${result.push.upstreamBranch}`
        : "Pushed",
    );
  }

  if (result.pr.status === "created") {
    parts.push(result.pr.number ? `Created PR #${result.pr.number}` : "Created PR");
  } else if (result.pr.status === "opened_existing") {
    parts.push(result.pr.number ? `PR #${result.pr.number}` : "Opened existing PR");
  }

  return parts.join(" · ") || "No changes needed.";
}

function buildGitActionMenuItems(
  gitStatus: GitStatusResult | null,
  isDisabled: boolean,
): GitActionMenuItem[] {
  if (!gitStatus) return [];

  const hasBranch = gitStatus.branch !== null;
  const hasOpenPr = gitStatus.openPr !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasAhead = gitStatus.aheadCount > 0;
  const canCommit = !isDisabled && hasChanges;
  const canPush = !isDisabled && hasBranch && !hasChanges && hasAhead;
  const canOpenPr = !isDisabled && hasOpenPr;
  const canCreatePr =
    !isDisabled &&
    hasBranch &&
    !hasOpenPr &&
    !hasChanges &&
    gitStatus.hasUpstream &&
    gitStatus.behindCount === 0;

  return [
    {
      id: "commit",
      label: "Commit",
      disabled: !canCommit,
      icon: "commit",
      kind: "run_action",
      action: "commit",
    },
    {
      id: "push",
      label: "Push",
      disabled: !canPush,
      icon: "push",
      kind: "run_action",
      action: "commit_push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: "View PR",
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: "Create PR",
          disabled: !canCreatePr,
          icon: "pr",
          kind: "run_action",
          action: "commit_push_pr",
        },
  ];
}

function getGitStatusQueryKey(gitCwd: string | null): readonly ["git", "status", string | null] {
  return ["git", "status", gitCwd];
}

function gitStatusQueryOptions(api: NativeApi | undefined, gitCwd: string | null) {
  return queryOptions({
    queryKey: getGitStatusQueryKey(gitCwd),
    queryFn: async () => {
      if (!api || !gitCwd) {
        throw new Error("Git status is unavailable.");
      }
      return api.git.status({ cwd: gitCwd });
    },
    enabled: !!api && !!gitCwd,
  });
}

export default function GitActionsControl({ api, gitCwd }: GitActionsControlProps) {
  const queryClient = useQueryClient();
  const [selectedGitActionId, setSelectedGitActionId] = useState<GitActionMenuItem["id"]>("commit");

  const { data: gitStatus = null, error: gitStatusError } = useQuery(
    gitStatusQueryOptions(api, gitCwd),
  );

  const runImmediateGitActionMutation = useMutation({
    mutationFn: async (action: GitStackedAction) => {
      if (!api || !gitCwd) {
        throw new Error("Git action is unavailable.");
      }
      return api.git.runStackedAction({ cwd: gitCwd, action });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["git"] });
    },
  });

  const isGitActionRunning = runImmediateGitActionMutation.isPending;

  const gitBaseDisabled = !api || !gitCwd || !gitStatus || isGitActionRunning;
  const gitActionMenuItems = useMemo(
    () => buildGitActionMenuItems(gitStatus, gitBaseDisabled),
    [gitBaseDisabled, gitStatus],
  );
  const selectedGitActionItem = useMemo(
    () => gitActionMenuItems.find((item) => item.id === selectedGitActionId) ?? null,
    [gitActionMenuItems, selectedGitActionId],
  );

  const refreshGitStatus = useCallback(async () => {
    if (!api || !gitCwd) return;
    await queryClient.invalidateQueries({ queryKey: ["git"] });
  }, [api, gitCwd, queryClient]);

  const runGitActionImmediately = useCallback(
    (action: GitStackedAction) => {
      const promise = runImmediateGitActionMutation.mutateAsync(action);
      toastManager.promise(promise, {
        loading: {
          title: action === "commit_push" ? "Pushing..." : "Creating PR...",
        },
        success: (result) => {
          const prUrl = result.pr.url;
          return {
            title: "Done",
            description: describeGitResult(result),
            ...(prUrl
              ? {
                  timeout: 10_000,
                  actionProps: {
                    children: "Open PR",
                    onClick: () => void api?.shell.openExternal(prUrl),
                  },
                }
              : {}),
          };
        },
        error: (err) => ({
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
        }),
      });
      void promise.catch(() => undefined);
    },
    [api, runImmediateGitActionMutation],
  );

  const openExistingPr = useCallback(() => {
    if (!api) {
      toastManager.add({ type: "error", title: "Link opening is unavailable." });
      return;
    }

    const prUrl = gitStatus?.openPr?.url ?? null;
    if (!prUrl) {
      toastManager.add({ type: "error", title: "No open PR found." });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : undefined,
      });
    });
  }, [api, gitStatus?.openPr?.url]);

  const runSelectedAction = useCallback(() => {
    if (!selectedGitActionItem || selectedGitActionItem.disabled) return;
    if (selectedGitActionItem.kind === "open_pr") {
      openExistingPr();
      return;
    }
    if (selectedGitActionItem.action) {
      runGitActionImmediately(selectedGitActionItem.action);
    }
  }, [openExistingPr, runGitActionImmediately, selectedGitActionItem]);

  useEffect(() => {
    setSelectedGitActionId("commit");
  }, [gitCwd]);

  useEffect(() => {
    if (selectedGitActionItem) return;
    const fallback = gitActionMenuItems.find((item) => !item.disabled) ?? gitActionMenuItems[0];
    if (fallback) {
      setSelectedGitActionId(fallback.id);
    }
  }, [gitActionMenuItems, selectedGitActionItem]);

  if (!gitCwd) return null;

  return (
    <Group aria-label="Git actions">
      <Button
        variant="outline"
        size="xs"
        disabled={!selectedGitActionItem || selectedGitActionItem.disabled || isGitActionRunning}
        onClick={runSelectedAction}
      >
        {isGitActionRunning ? "Running..." : selectedGitActionItem?.label ?? "Git actions"}
      </Button>
      <GroupSeparator />
      <Menu
        onOpenChange={(open) => {
          if (open) void refreshGitStatus();
        }}
      >
        <MenuTrigger
          render={<Button aria-label="Git action options" size="icon-xs" variant="outline" />}
          disabled={!gitStatus || isGitActionRunning}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" sideOffset={4}>
          {gitActionMenuItems.map((item) => (
            <MenuItem
              key={`${item.id}-${item.label}`}
              disabled={item.disabled}
              onClick={() => {
                setSelectedGitActionId(item.id);
                if (item.kind === "open_pr") {
                  openExistingPr();
                } else if (item.action) {
                  runGitActionImmediately(item.action);
                }
              }}
            >
              <GitActionItemIcon icon={item.icon} />
              {item.label}
            </MenuItem>
          ))}
          {gitStatus?.branch === null && (
            <p className="px-2 py-1.5 text-xs text-warning">
              Detached HEAD: push and PR are unavailable.
            </p>
          )}
          {gitStatus &&
            gitStatus.branch !== null &&
            !gitStatus.hasWorkingTreeChanges &&
            gitStatus.aheadCount === 0 &&
            gitStatus.behindCount > 0 && (
              <p className="px-2 py-1.5 text-xs text-warning">
                Behind upstream. Pull/rebase first.
              </p>
            )}
          {gitStatusError && (
            <p className="px-2 py-1.5 text-xs text-destructive">{gitStatusError.message}</p>
          )}
        </MenuPopup>
      </Menu>
    </Group>
  );
}
