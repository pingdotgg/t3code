import type { GitBranch } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { readNativeApi } from "../session-logic";
import { useStore } from "../store";

interface BranchToolbarProps {
  envMode: "local" | "worktree";
  onEnvModeChange: (mode: "local" | "worktree") => void;
  envLocked: boolean;
}

export default function BranchToolbar({ envMode, onEnvModeChange, envLocked }: BranchToolbarProps) {
  const { state, dispatch } = useStore();
  const api = useMemo(() => readNativeApi(), []);
  const queryClient = useQueryClient();

  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const branchMenuRef = useRef<HTMLDivElement>(null);

  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId);
  const activeProject = state.projects.find((project) => project.id === activeThread?.projectId);
  const activeThreadId = activeThread?.id;
  const activeThreadBranch = activeThread?.branch ?? null;
  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd;

  // ── Queries ───────────────────────────────────────────────────────────

  const branchesQuery = useQuery({
    queryKey: ["git", "branches", branchCwd],
    queryFn: () => api!.git.listBranches({ cwd: branchCwd! }),
    enabled: !!api && !!branchCwd,
  });

  const branches = branchesQuery.data?.branches ?? [];
  const isRepo = branchesQuery.data?.isRepo ?? false;

  // ── Mutations ─────────────────────────────────────────────────────────

  const checkoutMutation = useMutation({
    mutationFn: (branch: string) => api!.git.checkout({ cwd: branchCwd!, branch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["git", "branches", branchCwd] }),
    onError: (error) =>
      setThreadError(error instanceof Error ? error.message : "Failed to checkout branch."),
  });

  const createBranchMutation = useMutation({
    mutationFn: (branch: string) =>
      api!.git
        .createBranch({ cwd: branchCwd!, branch })
        .then(() => api!.git.checkout({ cwd: branchCwd!, branch })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["git", "branches", branchCwd] }),
    onError: (error) =>
      setThreadError(error instanceof Error ? error.message : "Failed to create branch."),
  });

  const initMutation = useMutation({
    mutationFn: () => api!.git.init({ cwd: branchCwd! }),
    onSuccess: () => {
      setThreadError(null);
      queryClient.invalidateQueries({ queryKey: ["git", "branches", branchCwd] });
    },
    onError: (error) =>
      setThreadError(error instanceof Error ? error.message : "Failed to initialize git repo."),
  });

  // ── Effects ───────────────────────────────────────────────────────────

  // Keep thread branch synced to git current branch for local threads.
  const queryBranches = branchesQuery.data?.branches;
  useEffect(() => {
    if (!activeThreadId || activeWorktreePath) return;
    const current = queryBranches?.find((branch) => branch.current);
    if (!current) return;
    if (current.name === activeThreadBranch) return;
    dispatch({
      type: "SET_THREAD_BRANCH",
      threadId: activeThreadId,
      branch: current.name,
      worktreePath: null,
    });
  }, [activeThreadId, activeWorktreePath, activeThreadBranch, queryBranches, dispatch]);

  useEffect(() => {
    if (!isBranchMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!branchMenuRef.current) return;
      if (event.target instanceof Node && !branchMenuRef.current.contains(event.target)) {
        setIsBranchMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isBranchMenuOpen]);

  // ── Helpers ───────────────────────────────────────────────────────────

  const setThreadError = (error: string | null) => {
    if (!activeThreadId) return;
    dispatch({ type: "SET_ERROR", threadId: activeThreadId, error });
  };

  const setThreadBranch = (branch: string | null, worktreePath: string | null) => {
    if (!activeThreadId) return;
    // If the effective cwd is about to change, stop the running session so the
    // next message creates a new one with the correct cwd.
    const sessionId = activeThread?.session?.sessionId;
    if (sessionId && worktreePath !== activeWorktreePath) {
      void api?.providers.stopSession({ sessionId }).catch(() => undefined);
    }
    dispatch({ type: "SET_THREAD_BRANCH", threadId: activeThreadId, branch, worktreePath });
  };

  const selectBranch = (branch: GitBranch) => {
    if (!api || !activeThreadId || !branchCwd) return;

    // For new worktree mode, selecting a branch picks the base branch.
    if (envMode === "worktree" && !envLocked && !activeWorktreePath) {
      setThreadError(null);
      setThreadBranch(branch.name, null);
      setIsBranchMenuOpen(false);
      return;
    }

    // If the branch already lives in a secondary worktree, point the thread
    // there instead of trying to checkout (which git would reject).
    // Ignore the main worktree (project cwd) — that's just a normal local checkout.
    const isSecondaryWorktree = branch.worktreePath && branch.worktreePath !== activeProject?.cwd;
    if (isSecondaryWorktree) {
      setThreadError(null);
      setThreadBranch(branch.name, branch.worktreePath);
      setIsBranchMenuOpen(false);
      return;
    }

    checkoutMutation.mutate(branch.name, {
      onSuccess: () => {
        setThreadError(null);
        setThreadBranch(branch.name, activeWorktreePath);
        setIsBranchMenuOpen(false);
      },
    });
  };

  const createBranch = () => {
    const name = newBranchName.trim();
    if (!api || !activeThreadId || !branchCwd || !name) return;
    createBranchMutation.mutate(name, {
      onSuccess: () => {
        setThreadError(null);
        setThreadBranch(name, activeWorktreePath);
        setNewBranchName("");
        setIsCreatingBranch(false);
        setIsBranchMenuOpen(false);
      },
    });
  };

  if (!activeThread || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 pb-3 pt-1">
      <div className="flex items-center gap-2">
        {envLocked || activeWorktreePath ? (
          <span className="inline-flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground/55">
            {activeWorktreePath ? "Worktree" : "Local"}
          </span>
        ) : (
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] transition-colors duration-150 ${
              envMode === "worktree"
                ? "bg-accent text-foreground/80"
                : "text-muted-foreground/60 hover:bg-accent/50 hover:text-muted-foreground/80"
            }`}
            onClick={() => onEnvModeChange(envMode === "local" ? "worktree" : "local")}
          >
            {envMode === "worktree" ? "New worktree" : "Local"}
          </button>
        )}
      </div>

      {!isRepo ? (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[12px] text-muted-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-foreground/80 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!branchCwd || initMutation.isPending}
          onClick={() => initMutation.mutate()}
        >
          {initMutation.isPending ? "Initializing\u2026" : "Initialize git"}
        </button>
      ) : (
        <div className="relative" ref={branchMenuRef}>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-muted-foreground/60 transition-colors duration-150 hover:bg-accent/50 hover:text-muted-foreground/80"
            onClick={() => setIsBranchMenuOpen((open) => !open)}
            disabled={branchesQuery.isLoading}
          >
            <span className="max-w-[240px] truncate font-mono">
              {activeThread.branch
                ? envMode === "worktree" && !activeWorktreePath
                  ? `From ${activeThread.branch}`
                  : activeThread.branch
                : "Select branch"}
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              className="opacity-40"
              aria-hidden="true"
            >
              <path
                d="M2.5 4L5 6.5L7.5 4"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {isBranchMenuOpen && (
            <div className="absolute bottom-full right-0 z-20 mb-2 w-[320px] rounded-2xl border border-border bg-popover/95 p-2 shadow-[0_16px_40px_rgba(0,0,0,0.55)] backdrop-blur">
              <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
                Branch
              </p>
              <div className="max-h-64 overflow-y-auto">
                {branches.map((branch) => {
                  const isSelected = branch.name === activeThread.branch;
                  const hasSecondaryWorktree =
                    branch.worktreePath && branch.worktreePath !== activeProject.cwd;
                  return (
                    <button
                      key={branch.name}
                      type="button"
                      className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-xl px-2 py-1.5 text-left font-mono text-xs transition-colors duration-150 ${
                        isSelected
                          ? "bg-accent text-foreground"
                          : "text-foreground/90 hover:bg-accent/50"
                      }`}
                      onClick={() => selectBranch(branch)}
                    >
                      <span className="truncate">{branch.name}</span>
                      {(branch.current || branch.isDefault || hasSecondaryWorktree) && (
                        <span className="shrink-0 text-[10px] text-muted-foreground/45">
                          {branch.current ? "current" : hasSecondaryWorktree ? "worktree" : "default"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {envMode === "local" && (
                <>
                  <div className="mx-1 my-1 h-px bg-border" />
                  {isCreatingBranch ? (
                    <form
                      className="flex items-center gap-1 px-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        createBranch();
                      }}
                    >
                      <input
                        type="text"
                        className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/30 focus:border-ring focus:outline-none"
                        placeholder="branch-name"
                        value={newBranchName}
                        onChange={(event) => setNewBranchName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setIsCreatingBranch(false);
                            setNewBranchName("");
                          }
                        }}
                        // biome-ignore lint/a11y/noAutofocus: branch name input should focus when shown
                        autoFocus
                      />
                      <button
                        type="submit"
                        disabled={!newBranchName.trim() || createBranchMutation.isPending}
                        className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground/80 disabled:opacity-30"
                      >
                        Create
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-foreground/80"
                      onClick={() => setIsCreatingBranch(true)}
                    >
                      + New branch
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
