import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ChevronLeftIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useResumeSessionIntentStore } from "~/resumeSessionIntentStore";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";

interface ResumeSessionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ResumeSessionDialog({ open, onOpenChange }: ResumeSessionDialogProps) {
  const projects = useProjects();
  const handleNewThread = useNewThreadHandler();
  const setResumeSessionIntent = useResumeSessionIntentStore(
    (store) => store.setResumeSessionIntent,
  );
  const [selectedProject, setSelectedProject] = useState<EnvironmentProject | null>(null);
  const [isResuming, setIsResuming] = useState(false);

  const sortedProjects = useMemo(
    () => [...projects].sort((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );

  const {
    data: sessionsResult,
    error: sessionsError,
    isPending: sessionsPending,
  } = useEnvironmentQuery(
    selectedProject === null
      ? null
      : serverEnvironment.listClaudeResumableSessions({
          environmentId: selectedProject.environmentId,
          input: { workspaceRoot: selectedProject.workspaceRoot },
        }),
  );
  const sessions = useMemo(
    () =>
      [...(sessionsResult?.sessions ?? [])].sort((left, right) =>
        right.lastActiveAt.localeCompare(left.lastActiveAt),
      ),
    [sessionsResult],
  );

  const handleClose = useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) setSelectedProject(null);
    },
    [onOpenChange],
  );

  const handleResume = useCallback(
    async (sessionId: string) => {
      if (!selectedProject || isResuming) return;
      setIsResuming(true);
      try {
        const projectRef = scopeProjectRef(selectedProject.environmentId, selectedProject.id);
        await handleNewThread(projectRef);
        const draftThread = useComposerDraftStore
          .getState()
          .getDraftThreadByProjectRef(projectRef);
        if (draftThread) {
          setResumeSessionIntent(draftThread.threadId, sessionId);
        }
        handleClose(false);
      } finally {
        setIsResuming(false);
      }
    },
    [selectedProject, isResuming, handleNewThread, setResumeSessionIntent, handleClose],
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Resume a Claude Code session</DialogTitle>
          <DialogDescription>
            {selectedProject
              ? `Pick a previous session from ${selectedProject.title} to continue.`
              : "Pick a project, then pick which on-disk session to resume."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-1">
          {selectedProject === null ? (
            sortedProjects.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Add a project first to see resumable sessions.
              </p>
            ) : (
              sortedProjects.map((project) => (
                <button
                  key={`${project.environmentId}:${project.id}`}
                  type="button"
                  onClick={() => setSelectedProject(project)}
                  className="flex w-full flex-col rounded-lg border border-transparent px-3 py-2 text-left hover:border-border hover:bg-muted/50"
                >
                  <span className="truncate text-sm font-medium text-foreground">
                    {project.title}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {project.workspaceRoot}
                  </span>
                </button>
              ))
            )
          ) : (
            <>
              <button
                type="button"
                onClick={() => setSelectedProject(null)}
                className="mb-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronLeftIcon className="size-3.5" />
                Back to projects
              </button>
              {sessionsPending ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Looking for sessions…
                </p>
              ) : sessionsError ? (
                <p className="py-6 text-center text-sm text-destructive">{sessionsError}</p>
              ) : sessions.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No resumable Claude Code sessions found for this project.
                </p>
              ) : (
                sessions.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    disabled={isResuming}
                    onClick={() => void handleResume(session.sessionId)}
                    className="flex w-full flex-col gap-0.5 rounded-lg border border-transparent px-3 py-2 text-left hover:border-border hover:bg-muted/50 disabled:opacity-50"
                  >
                    <span className="truncate text-sm text-foreground">
                      {session.label ?? "Untitled session"}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{formatRelativeTimeLabel(session.lastActiveAt)}</span>
                      <span aria-hidden>·</span>
                      <span>{session.messageCount} messages</span>
                    </span>
                  </button>
                ))
              )}
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
