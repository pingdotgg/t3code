import {
  type GitRunStackedActionResult,
  type GitStackedAction,
  type GitStatusResult,
  type NativeApi,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  CircleIcon,
  CloudUploadIcon,
  GitCommitIcon,
  GithubIcon,
  Loader2Icon,
  MinusIcon,
  XIcon,
} from "lucide-react";

interface GitActionsControlProps {
  api: NativeApi | undefined;
  gitCwd: string | null;
}

interface GitActionMenuItem {
  id: GitStackedAction;
  label: string;
  disabled: boolean;
  icon: "commit" | "push" | "pr";
}

type GitProgressStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

interface GitProgressStep {
  id: "generate" | "commit" | "push" | "pr";
  label: string;
  status: GitProgressStepStatus;
  detail?: string;
}

function GitActionIcon(props: { icon: GitActionMenuItem["icon"]; disabled: boolean }) {
  const toneClass = props.disabled ? "text-muted-foreground/45" : "text-foreground/85";

  if (props.icon === "commit") {
    return <GitCommitIcon className={`h-5 w-5 shrink-0 ${toneClass}`} />;
  }

  if (props.icon === "push") {
    return <CloudUploadIcon className={`h-5 w-5 shrink-0 ${toneClass}`} />;
  }

  return <GithubIcon className={`h-5 w-5 shrink-0 ${toneClass}`} />;
}

function gitActionModalTitle(action: GitStackedAction): string {
  if (action === "commit") return "Commit your changes";
  if (action === "commit_push") return "Commit and push changes";
  return "Commit, push and open PR";
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
  if (action === "commit") return "Commit";
  if (action === "commit_push") return "Commit & Push";
  return "Commit, Push & Open PR";
}

function isViewPrOnlyAction(
  action: GitStackedAction,
  gitStatus: GitStatusResult | null,
): boolean {
  if (action !== "commit_push_pr") return false;
  if (!gitStatus?.openPr) return false;
  return !gitStatus.hasWorkingTreeChanges && gitStatus.aheadCount === 0;
}

export default function GitActionsControl({ api, gitCwd }: GitActionsControlProps) {
  const [isGitMenuOpen, setIsGitMenuOpen] = useState(false);
  const [isGitActionRunning, setIsGitActionRunning] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [gitActionError, setGitActionError] = useState<string | null>(null);
  const [gitModalAction, setGitModalAction] = useState<GitStackedAction | null>(null);
  const [gitModalCommitMessage, setGitModalCommitMessage] = useState("");
  const [gitModalProgress, setGitModalProgress] = useState<GitProgressStep[]>([]);
  const [gitModalError, setGitModalError] = useState<string | null>(null);
  const [gitModalResult, setGitModalResult] = useState<GitRunStackedActionResult | null>(null);
  const gitMenuRef = useRef<HTMLDivElement>(null);
  const latestGitCwdRef = useRef<string | null>(null);

  const gitBaseDisabled = !api || !gitCwd || !gitStatus || isGitActionRunning;
  const gitActionMenuItems = useMemo<GitActionMenuItem[]>(() => {
    if (!gitStatus) return [];

    const hasBranch = gitStatus.branch !== null;
    const hasOpenPr = gitStatus.openPr !== null;
    const canCommit = !gitBaseDisabled && gitStatus.hasWorkingTreeChanges;
    const canPush =
      !gitBaseDisabled &&
      hasBranch &&
      (gitStatus.hasWorkingTreeChanges || gitStatus.aheadCount > 0);
    const canViewPr =
      !gitBaseDisabled &&
      hasBranch &&
      gitStatus.behindCount === 0 &&
      (gitStatus.hasWorkingTreeChanges || gitStatus.aheadCount > 0 || hasOpenPr);

    return [
      {
        id: "commit",
        label: "Commit",
        disabled: !canCommit,
        icon: "commit",
      },
      {
        id: "commit_push",
        label: "Push",
        disabled: !canPush,
        icon: "push",
      },
      {
        id: "commit_push_pr",
        label: "View PR",
        disabled: !canViewPr,
        icon: "pr",
      },
    ];
  }, [gitBaseDisabled, gitStatus]);

  const isGitModalOpen = gitModalAction !== null;
  const gitModalPreviewSteps = useMemo(
    () =>
      gitModalAction
        ? initialGitProgressSteps(gitModalAction, gitModalCommitMessage)
        : ([] as GitProgressStep[]),
    [gitModalAction, gitModalCommitMessage],
  );
  const gitModalSteps = gitModalProgress.length > 0 ? gitModalProgress : gitModalPreviewSteps;

  useEffect(() => {
    latestGitCwdRef.current = gitCwd;
  }, [gitCwd]);

  const refreshGitStatus = useCallback(async () => {
    const requestCwd = gitCwd;
    if (!api || !requestCwd) {
      setGitStatus(null);
      return;
    }

    const nextStatus = await api.git.status({ cwd: requestCwd });
    if (latestGitCwdRef.current !== requestCwd) return;
    setGitStatus(nextStatus);
    setGitActionError(null);
  }, [api, gitCwd]);

  const openGitActionModal = useCallback((action: GitStackedAction) => {
    setIsGitMenuOpen(false);
    setGitModalAction(action);
    setGitModalCommitMessage("");
    setGitModalProgress([]);
    setGitModalError(null);
    setGitModalResult(null);
    setGitActionError(null);
  }, []);

  const closeGitActionModal = useCallback(() => {
    if (isGitActionRunning) return;
    setGitModalAction(null);
    setGitModalCommitMessage("");
    setGitModalProgress([]);
    setGitModalError(null);
    setGitModalResult(null);
  }, [isGitActionRunning]);

  const runGitActionImmediately = useCallback(
    async (action: GitStackedAction) => {
      if (!api || !gitCwd) return;
      const actionCwd = gitCwd;

      setIsGitMenuOpen(false);
      setGitActionError(null);
      setGitModalError(null);
      setIsGitActionRunning(true);

      try {
        await api.git.runStackedAction({
          cwd: actionCwd,
          action,
        });
      } catch (error) {
        setGitActionError(error instanceof Error ? error.message : "Git action failed.");
      } finally {
        setIsGitActionRunning(false);
        try {
          if (latestGitCwdRef.current === actionCwd) {
            await refreshGitStatus();
          }
        } catch {
          setGitStatus(null);
        }
      }
    },
    [api, gitCwd, refreshGitStatus],
  );

  const runGitAction = useCallback(async () => {
    if (!api || !gitCwd || !gitModalAction) return;
    const actionCwd = gitCwd;
    const action = gitModalAction;
    const commitMessage = gitModalCommitMessage.trim();
    const includeGeneratedCommitMessage = commitMessage.length === 0;

    setIsGitActionRunning(true);
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
          updateStep(
            "generate",
            "completed",
            commitRun.commit.subject
              ? `Generated: ${commitRun.commit.subject}`
              : "Generated commit message.",
          );
        } else {
          updateStep("generate", "skipped", "No local changes to commit.");
        }
      }

      if (commitRun.commit.status === "created") {
        updateStep(
          "commit",
          "completed",
          commitRun.commit.subject ?? "Committed local changes.",
        );
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
            prRun.pr.number
              ? `Opened existing PR #${prRun.pr.number}.`
              : "Opened existing PR.",
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
      setIsGitActionRunning(false);
      try {
        if (latestGitCwdRef.current === actionCwd) {
          await refreshGitStatus();
        }
      } catch {
        setGitStatus(null);
      }
    }
  }, [api, gitCwd, gitModalAction, gitModalCommitMessage, refreshGitStatus]);

  useEffect(() => {
    setGitActionError(null);
    setGitModalError(null);
    setGitModalAction(null);
    setGitModalCommitMessage("");
    setGitModalProgress([]);
    setGitModalResult(null);
  }, [gitCwd]);

  useEffect(() => {
    let cancelled = false;
    if (!api || !gitCwd) {
      setGitStatus(null);
      return;
    }

    const load = async () => {
      try {
        const nextStatus = await api.git.status({ cwd: gitCwd });
        if (!cancelled) {
          setGitStatus(nextStatus);
          setGitActionError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setGitStatus(null);
          setGitActionError(error instanceof Error ? error.message : "Failed to read git status.");
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [api, gitCwd]);

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
                  key={item.id}
                  type="button"
                  className="mb-1.5 flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-[14px] text-foreground transition-colors duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:text-muted-foreground/65"
                  disabled={item.disabled}
                  onClick={() => {
                    if (isViewPrOnlyAction(item.id, gitStatus)) {
                      void runGitActionImmediately(item.id);
                      return;
                    }
                    openGitActionModal(item.id);
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
            {gitActionError && (
              <p className="px-3 pt-2 text-[11px] text-rose-500 dark:text-rose-300">
                {gitActionError}
              </p>
            )}
          </div>
        )}
      </div>

      {isGitModalOpen && gitModalAction && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-4 py-6"
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
                    icon={
                      gitModalAction === "commit"
                        ? "commit"
                        : gitModalAction === "commit_push"
                          ? "push"
                          : "pr"
                    }
                    disabled={false}
                  />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
                    Git actions
                  </p>
                  <h3 className="text-3xl font-semibold tracking-tight text-foreground">
                    {gitActionModalTitle(gitModalAction)}
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
                  {gitStatus?.hasWorkingTreeChanges ? "Working tree has changes" : "No local changes"}
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
                disabled={isGitActionRunning || gitModalResult !== null}
              />
              <p className="mt-1.5 text-xs text-muted-foreground/65">
                Leave this empty to use AI-generated commit text.
              </p>
            </div>

            <div className="mt-6">
              <p className="text-sm font-medium text-foreground">Next steps</p>
              <div className="mt-2 overflow-hidden rounded-2xl border border-border">
                {gitModalSteps.map((step, index) => {
                  const borderClass =
                    index < gitModalSteps.length - 1 ? "border-b border-border/70" : "";
                  const statusTextClass =
                    step.status === "failed"
                      ? "text-rose-500 dark:text-rose-300"
                      : step.status === "completed"
                        ? "text-emerald-600 dark:text-emerald-300"
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

            {(gitModalError ?? gitActionError) && (
              <div className="mt-4 rounded-lg border border-rose-300/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-200">
                {gitModalError ?? gitActionError}
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
                  disabled={isGitActionRunning}
                >
                  {isGitActionRunning ? "Running..." : runActionLabel(gitModalAction)}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
