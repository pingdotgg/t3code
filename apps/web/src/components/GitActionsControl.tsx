import {
  type GitRunStackedActionResult,
  type GitStackedAction,
  type GitStatusResult,
  type NativeApi,
} from "@t3tools/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  CircleIcon,
  CloudUploadIcon,
  GitCommitIcon,
  Loader2Icon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import { GitHubIcon } from "./Icons";

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
  kind: "open_modal" | "run_action" | "open_pr";
  action?: GitStackedAction;
}

interface GitModalActionOption {
  action: GitStackedAction;
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  detail?: string;
}

type GitProgressStepStatus = "pending" | "running" | "completed" | "skipped" | "failed";

interface GitProgressStep {
  id: "generate" | "commit" | "push" | "pr";
  label: string;
  status: GitProgressStepStatus;
  detail?: string;
}

function GitActionIcon(props: { icon: GitActionIconName; disabled: boolean }) {
  const toneClass = props.disabled ? "text-muted-foreground/45" : "text-foreground/85";

  if (props.icon === "commit") {
    return <GitCommitIcon className={`h-5 w-5 shrink-0 ${toneClass}`} />;
  }

  if (props.icon === "push") {
    return <CloudUploadIcon className={`h-5 w-5 shrink-0 ${toneClass}`} />;
  }

  return <GitHubIcon className={`h-5 w-5 shrink-0 ${toneClass}`} />;
}

function gitActionModalTitle(): string {
  return "Commit your changes";
}

function initialGitProgressSteps(
  action: GitStackedAction,
  commitMessage: string,
): GitProgressStep[] {
  const hasCustomMessage = commitMessage.trim().length > 0;
  const steps: GitProgressStep[] = [];

  if (!hasCustomMessage) {
    steps.push({
      id: "generate",
      label: "Generate commit message",
      status: "pending",
    });
  }

  steps.push({
    id: "commit",
    label: "Commit changes",
    status: "pending",
  });

  if (action !== "commit") {
    steps.push({
      id: "push",
      label: "Push branch",
      status: "pending",
    });
  }

  if (action === "commit_push_pr") {
    steps.push({
      id: "pr",
      label: "Create or open PR",
      status: "pending",
    });
  }

  return steps;
}

function updateProgressStep(
  steps: GitProgressStep[],
  id: GitProgressStep["id"],
  status: GitProgressStepStatus,
  detail?: string,
): GitProgressStep[] {
  return steps.map((step) => {
    if (step.id !== id) return step;
    return {
      ...step,
      status,
      ...(detail ? { detail } : {}),
    };
  });
}

function runActionLabel(action: GitStackedAction): string {
  if (action === "commit") return "Commit changes";
  if (action === "commit_push") return "Commit and push";
  return "Commit and create PR";
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
      kind: "open_modal",
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

function buildGitModalActionOptions(
  gitStatus: GitStatusResult | null,
  isDisabled: boolean,
): GitModalActionOption[] {
  const hasBranch = gitStatus?.branch !== null;
  const hasOpenPr = gitStatus?.openPr !== null;

  return [
    {
      action: "commit",
      label: "Commit",
      disabled: isDisabled,
      icon: "commit",
    },
    {
      action: "commit_push",
      label: "Commit and push",
      disabled: isDisabled || !hasBranch,
      icon: "push",
      ...(!hasBranch ? { detail: "Requires an attached branch." } : {}),
    },
    {
      action: "commit_push_pr",
      label: "Commit and create PR",
      disabled: isDisabled || !hasBranch || hasOpenPr,
      icon: "pr",
      ...(!hasBranch
        ? { detail: "Requires an attached branch." }
        : hasOpenPr
          ? { detail: "A PR is already open for this branch." }
          : {}),
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
  const [isGitMenuOpen, setIsGitMenuOpen] = useState(false);
  const [isGitModalActionRunning, setIsGitModalActionRunning] = useState(false);
  const [gitActionError, setGitActionError] = useState<string | null>(null);
  const [isGitModalOpen, setIsGitModalOpen] = useState(false);
  const [gitModalSelectedAction, setGitModalSelectedAction] = useState<GitStackedAction>("commit");
  const [gitModalCommitMessage, setGitModalCommitMessage] = useState("");
  const [gitModalProgress, setGitModalProgress] = useState<GitProgressStep[]>([]);
  const [gitModalError, setGitModalError] = useState<string | null>(null);
  const [gitModalResult, setGitModalResult] = useState<GitRunStackedActionResult | null>(null);
  const gitMenuRef = useRef<HTMLDivElement>(null);

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
    onMutate: () => {
      setIsGitMenuOpen(false);
      setGitActionError(null);
      setGitModalError(null);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["git"] });
    },
    onError: (error) => {
      setGitActionError(error instanceof Error ? error.message : "Git action failed.");
    },
  });

  const isGitActionRunning = isGitModalActionRunning || runImmediateGitActionMutation.isPending;

  const gitBaseDisabled = !api || !gitCwd || !gitStatus || isGitActionRunning;
  const gitActionMenuItems = useMemo(
    () => buildGitActionMenuItems(gitStatus, gitBaseDisabled),
    [gitBaseDisabled, gitStatus],
  );
  const gitModalActionOptions = useMemo(
    () => buildGitModalActionOptions(gitStatus, !gitStatus || isGitActionRunning),
    [gitStatus, isGitActionRunning],
  );
  const selectedGitModalActionOption = useMemo(
    () => gitModalActionOptions.find((option) => option.action === gitModalSelectedAction) ?? null,
    [gitModalActionOptions, gitModalSelectedAction],
  );
  const visibleGitActionError = gitActionError ?? gitStatusError?.message;
  const gitModalHasProgress = gitModalProgress.length > 0;
  const gitModalSelectionMode = !gitModalHasProgress && gitModalResult === null;
  const gitModalSteps = gitModalProgress;

  const refreshGitStatus = useCallback(async () => {
    if (!api || !gitCwd) return;
    await queryClient.invalidateQueries({ queryKey: ["git"] });
    setGitActionError(null);
  }, [api, gitCwd, queryClient]);

  const openGitActionModal = useCallback(() => {
    setIsGitMenuOpen(false);
    setIsGitModalOpen(true);
    setGitModalSelectedAction("commit");
    setGitModalCommitMessage("");
    setGitModalProgress([]);
    setGitModalError(null);
    setGitModalResult(null);
    setGitActionError(null);
  }, []);

  const closeGitActionModal = useCallback(() => {
    if (isGitActionRunning) return;
    setIsGitModalOpen(false);
    setGitModalSelectedAction("commit");
    setGitModalCommitMessage("");
    setGitModalProgress([]);
    setGitModalError(null);
    setGitModalResult(null);
  }, [isGitActionRunning]);

  const runGitActionImmediately = useCallback(
    (action: GitStackedAction) => {
      runImmediateGitActionMutation.mutate(action);
    },
    [runImmediateGitActionMutation],
  );

  const openExistingPr = useCallback(() => {
    setIsGitMenuOpen(false);
    setGitActionError(null);
    if (!api) {
      setGitActionError("Link opening is unavailable.");
      return;
    }

    const prUrl = gitStatus?.openPr?.url ?? null;
    if (!prUrl) {
      setGitActionError("No open PR found for the current branch.");
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      setGitActionError(error instanceof Error ? error.message : "Unable to open PR link.");
    });
  }, [api, gitStatus?.openPr?.url]);

  const openPrFromResult = useCallback(() => {
    if (!api) {
      setGitModalError("Link opening is unavailable.");
      return;
    }

    const prUrl = gitModalResult?.pr.url ?? null;
    if (!prUrl) return;

    void api.shell.openExternal(prUrl).catch((error) => {
      setGitModalError(error instanceof Error ? error.message : "Unable to open PR link.");
    });
  }, [api, gitModalResult?.pr.url]);

  const runGitAction = useCallback(async () => {
    if (!api || !gitCwd || !isGitModalOpen) return;
    if (!selectedGitModalActionOption || selectedGitModalActionOption.disabled) return;
    const actionCwd = gitCwd;
    const action = selectedGitModalActionOption.action;
    const commitMessage = gitModalCommitMessage.trim();
    const includeGeneratedCommitMessage = commitMessage.length === 0;

    setIsGitModalActionRunning(true);
    setGitModalError(null);
    setGitActionError(null);
    setGitModalResult(null);
    setGitModalProgress(initialGitProgressSteps(action, commitMessage));

    let commit: GitRunStackedActionResult["commit"] = {
      status: "skipped_no_changes",
    };
    let push: GitRunStackedActionResult["push"] = {
      status: "skipped_not_requested",
    };
    let pr: GitRunStackedActionResult["pr"] = {
      status: "skipped_not_requested",
    };

    const updateStep = (
      id: GitProgressStep["id"],
      status: GitProgressStepStatus,
      detail?: string,
    ) => {
      setGitModalProgress((steps) => updateProgressStep(steps, id, status, detail));
    };

    try {
      if (includeGeneratedCommitMessage) {
        updateStep("generate", "running");
      } else {
        updateStep("commit", "running");
      }

      const commitRun = await api.git.runStackedAction({
        cwd: actionCwd,
        action: "commit",
        ...(commitMessage.length > 0 ? { commitMessage } : {}),
      });
      commit = commitRun.commit;

      if (includeGeneratedCommitMessage) {
        if (commitRun.commit.status === "created") {
          if (commitRun.commit.subject) {
            setGitModalCommitMessage(commitRun.commit.subject);
          }
          updateStep("generate", "completed");
        } else {
          updateStep("generate", "skipped", "No local changes to commit.");
        }
      }

      if (commitRun.commit.status === "created") {
        updateStep("commit", "completed", commitRun.commit.subject ?? "Committed local changes.");
      } else {
        updateStep("commit", "skipped", "No local changes to commit.");
      }

      if (action !== "commit") {
        updateStep("push", "running");
        const pushRun = await api.git.runStackedAction({
          cwd: actionCwd,
          action: "commit_push",
        });
        push = pushRun.push;
        if (pushRun.push.status === "pushed") {
          updateStep(
            "push",
            "completed",
            pushRun.push.upstreamBranch
              ? `Pushed to ${pushRun.push.upstreamBranch}.`
              : "Pushed latest commits.",
          );
        } else {
          updateStep("push", "skipped", "Branch already up to date.");
        }
      }

      if (action === "commit_push_pr") {
        updateStep("pr", "running");
        const prRun = await api.git.runStackedAction({
          cwd: actionCwd,
          action: "commit_push_pr",
        });
        pr = prRun.pr;
        if (prRun.pr.status === "opened_existing") {
          updateStep(
            "pr",
            "completed",
            prRun.pr.number ? `Opened existing PR #${prRun.pr.number}.` : "Opened existing PR.",
          );
        } else if (prRun.pr.status === "created") {
          updateStep(
            "pr",
            "completed",
            prRun.pr.number ? `Created PR #${prRun.pr.number}.` : "Created PR.",
          );
        } else {
          updateStep("pr", "skipped", "PR step was not requested.");
        }
      }

      setGitModalResult({ action, commit, push, pr });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git action failed.";
      setGitModalError(message);
      setGitActionError(message);
      setGitModalProgress((steps) => {
        const active = steps.find((step) => step.status === "running");
        if (!active) return steps;
        return updateProgressStep(steps, active.id, "failed", message);
      });
    } finally {
      setIsGitModalActionRunning(false);
      await refreshGitStatus().catch(() => undefined);
    }
  }, [
    api,
    gitCwd,
    gitModalCommitMessage,
    isGitModalOpen,
    refreshGitStatus,
    selectedGitModalActionOption,
  ]);

  useEffect(() => {
    setGitActionError(null);
    setGitModalError(null);
    setIsGitModalOpen(false);
    setGitModalSelectedAction("commit");
    setGitModalCommitMessage("");
    setGitModalProgress([]);
    setGitModalResult(null);
  }, [gitCwd]);

  useEffect(() => {
    if (!isGitModalOpen) return;
    if (selectedGitModalActionOption && !selectedGitModalActionOption.disabled) return;

    const fallback = gitModalActionOptions.find((option) => !option.disabled);
    if (fallback) {
      setGitModalSelectedAction(fallback.action);
    }
  }, [gitModalActionOptions, isGitModalOpen, selectedGitModalActionOption]);

  useEffect(() => {
    if (!isGitMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!gitMenuRef.current) return;
      if (event.target instanceof Node && !gitMenuRef.current.contains(event.target)) {
        setIsGitMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isGitMenuOpen]);

  useEffect(() => {
    if (!isGitModalOpen) return;

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isGitActionRunning) return;
      closeGitActionModal();
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [closeGitActionModal, isGitActionRunning, isGitModalOpen]);

  if (!gitCwd) return null;

  return (
    <>
      <div className="relative" ref={gitMenuRef}>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-foreground/80 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => {
            if (!isGitMenuOpen) {
              void refreshGitStatus().catch(() => undefined);
            }
            setIsGitMenuOpen((v) => !v);
          }}
          disabled={!gitStatus || isGitActionRunning}
        >
          {isGitActionRunning ? "Running..." : "Git actions"}
          <span aria-hidden="true">▾</span>
        </button>
        {isGitMenuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 w-[280px] rounded-3xl border border-border bg-popover p-3 shadow-xl">
            <p className="px-3 pb-2 text-[13px] text-muted-foreground/75">Git actions</p>
            {gitActionMenuItems.map((item) => {
              return (
                <button
                  key={`${item.id}-${item.label}`}
                  type="button"
                  className="mb-1.5 flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-[14px] text-foreground transition-colors duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:text-muted-foreground/65"
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.kind === "open_modal") {
                      openGitActionModal();
                      return;
                    }

                    if (item.kind === "open_pr") {
                      openExistingPr();
                      return;
                    }

                    if (item.action) {
                      void runGitActionImmediately(item.action);
                    }
                  }}
                >
                  <GitActionIcon icon={item.icon} disabled={item.disabled} />
                  <span>{item.label}</span>
                </button>
              );
            })}
            {gitStatus?.branch === null && (
              <p className="px-2 pt-1 text-[10px] text-amber-500 dark:text-amber-300">
                Detached HEAD: push and PR actions are unavailable.
              </p>
            )}
            {gitStatus &&
              gitStatus.branch !== null &&
              !gitStatus.hasWorkingTreeChanges &&
              gitStatus.aheadCount === 0 &&
              gitStatus.behindCount > 0 && (
                <p className="px-3 pt-1 text-[10px] text-amber-500 dark:text-amber-300">
                  Branch is behind upstream. Pull/rebase before opening a PR.
                </p>
              )}
            {visibleGitActionError && (
              <p className="px-3 pt-2 text-[11px] text-rose-500 dark:text-rose-300">
                {visibleGitActionError}
              </p>
            )}
          </div>
        )}
      </div>

      {isGitModalOpen && (
        <div
          className="fixed inset-0 z-80 flex items-center justify-center bg-black/35 px-4 py-6"
          onMouseDown={() => {
            closeGitActionModal();
          }}
        >
          <div
            className="w-full max-w-[640px] rounded-3xl border border-border bg-popover p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Git action confirmation"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-accent p-3">
                  <GitActionIcon
                    icon={selectedGitModalActionOption?.icon ?? "commit"}
                    disabled={false}
                  />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
                    Git actions
                  </p>
                  <h3 className="text-3xl font-semibold tracking-tight text-foreground">
                    {gitActionModalTitle()}
                  </h3>
                </div>
              </div>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground/60 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                onClick={closeGitActionModal}
                disabled={isGitActionRunning}
                aria-label="Close git action dialog"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-6 space-y-2 rounded-2xl border border-border/80 bg-card/40 px-4 py-3">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-muted-foreground/70">Branch</span>
                <span className="font-mono text-foreground">
                  {gitStatus?.branch ?? "(detached HEAD)"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-muted-foreground/70">Changes</span>
                <span className="text-foreground">
                  {gitStatus?.hasWorkingTreeChanges
                    ? "Working tree has changes"
                    : "No local changes"}
                </span>
              </div>
            </div>
            <div className="mt-6">
              <label
                htmlFor="git-commit-message"
                className="mb-2 block text-sm font-medium text-foreground"
              >
                Commit message
              </label>
              <textarea
                id="git-commit-message"
                rows={3}
                className="w-full resize-none rounded-2xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                placeholder="Leave blank to autogenerate a commit message"
                value={gitModalCommitMessage}
                onChange={(event) => setGitModalCommitMessage(event.target.value)}
                disabled={!gitModalSelectionMode || isGitActionRunning}
              />
            </div>
            <div className="mt-6">
              <p className="text-sm font-medium text-foreground">Next steps</p>
              <div className="mt-2 overflow-hidden rounded-2xl border border-border">
                {gitModalSelectionMode &&
                  gitModalActionOptions.map((option, index) => {
                    const borderClass =
                      index < gitModalActionOptions.length - 1 ? "border-b border-border/70" : "";
                    const selected = option.action === gitModalSelectedAction && !option.disabled;
                    const disabled = option.disabled || isGitActionRunning;

                    return (
                      <button
                        key={option.action}
                        type="button"
                        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 ${borderClass} ${
                          selected
                            ? "bg-accent/55"
                            : disabled
                              ? "bg-card/25"
                              : "bg-card/45 hover:bg-accent/35"
                        } disabled:cursor-not-allowed`}
                        disabled={disabled}
                        onClick={() => {
                          setGitModalSelectedAction(option.action);
                        }}
                      >
                        <span className="mt-0.5">
                          <GitActionIcon icon={option.icon} disabled={option.disabled} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p
                            className={`text-sm ${disabled ? "text-muted-foreground/60" : "text-foreground"}`}
                          >
                            {option.label}
                          </p>
                          {option.detail && (
                            <p
                              className={`mt-0.5 text-xs ${disabled ? "text-muted-foreground/55" : "text-muted-foreground/70"}`}
                            >
                              {option.detail}
                            </p>
                          )}
                        </div>
                        {selected && !disabled ? (
                          <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                        ) : null}
                      </button>
                    );
                  })}
                {!gitModalSelectionMode &&
                  gitModalSteps.map((step, index) => {
                    const borderClass =
                      index < gitModalSteps.length - 1 ? "border-b border-border/70" : "";
                    const statusTextClass =
                      step.status === "failed"
                        ? "text-rose-500 dark:text-rose-300"
                        : "text-muted-foreground/70";

                    return (
                      <div
                        key={step.id}
                        className={`flex items-start gap-3 bg-card/45 px-4 py-3 ${borderClass}`}
                      >
                        <span className="mt-0.5">
                          {step.status === "running" ? (
                            <Loader2Icon className="h-4 w-4 animate-spin text-foreground" />
                          ) : step.status === "completed" ? (
                            <CheckIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                          ) : step.status === "skipped" ? (
                            <MinusIcon className="h-4 w-4 text-muted-foreground/70" />
                          ) : step.status === "failed" ? (
                            <XIcon className="h-4 w-4 text-rose-500 dark:text-rose-300" />
                          ) : (
                            <CircleIcon className="h-4 w-4 text-muted-foreground/60" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm text-foreground">{step.label}</p>
                          {step.detail && (
                            <p className={`mt-0.5 text-xs ${statusTextClass}`}>{step.detail}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
            {(gitModalError ?? visibleGitActionError) && (
              <div className="mt-4 rounded-lg border border-rose-300/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-200">
                {gitModalError ?? visibleGitActionError}
              </div>
            )}
            {gitModalResult?.pr.url && (
              <div className="mt-4 rounded-lg border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground/80">
                PR:{" "}
                <a
                  href={gitModalResult.pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline underline-offset-2"
                >
                  {gitModalResult.pr.url}
                </a>
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              {gitModalResult?.pr.url && (
                <button
                  type="button"
                  className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition-colors duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={openPrFromResult}
                  disabled={isGitActionRunning}
                >
                  Open PR
                </button>
              )}
              <button
                type="button"
                className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition-colors duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                onClick={closeGitActionModal}
                disabled={isGitActionRunning}
              >
                {gitModalResult ? "Done" : "Cancel"}
              </button>
              {!gitModalResult && (
                <button
                  type="button"
                  className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors duration-150 hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => {
                    void runGitAction();
                  }}
                  disabled={isGitActionRunning || !selectedGitModalActionOption}
                >
                  {isGitActionRunning
                    ? "Running..."
                    : gitModalSelectionMode
                      ? "Continue"
                      : runActionLabel(gitModalSelectedAction)}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
