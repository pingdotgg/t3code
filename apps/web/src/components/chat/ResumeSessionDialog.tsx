import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ProviderDriverKind } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import { newDraftId, newThreadId } from "~/lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import {
  getDefaultProviderInstanceModel,
  resolveSelectableProviderInstance,
} from "~/providerInstances";
import { useResumeSessionIntentStore } from "~/resumeSessionIntentStore";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

interface ResumeSessionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ResumeSessionDialog({ open, onOpenChange }: ResumeSessionDialogProps) {
  const projects = useProjects();
  const router = useRouter();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const setResumeSessionIntent = useResumeSessionIntentStore(
    (store) => store.setResumeSessionIntent,
  );
  const [selectedProject, setSelectedProject] = useState<EnvironmentProject | null>(null);
  const [isResuming, setIsResuming] = useState(false);

  const sortedProjects = useMemo(
    () => [...projects].sort((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );

  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(selectedProject?.environmentId ?? null),
  );
  const claudeProviders = useMemo(
    () => (serverConfig?.providers ?? []).filter((provider) => provider.driver === CLAUDE_DRIVER),
    [serverConfig],
  );
  const claudeInstanceId = useMemo(
    () => resolveSelectableProviderInstance(claudeProviders, undefined),
    [claudeProviders],
  );
  const claudeModel = useMemo(
    () =>
      claudeInstanceId
        ? getDefaultProviderInstanceModel(claudeProviders, claudeInstanceId)
        : undefined,
    [claudeProviders, claudeInstanceId],
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
          input: {
            workspaceRoot: selectedProject.workspaceRoot,
            ...(claudeInstanceId ? { providerInstanceId: claudeInstanceId } : {}),
          },
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
      if (!selectedProject || !claudeInstanceId || !claudeModel || isResuming) return;
      setIsResuming(true);
      try {
        const projectRef = scopeProjectRef(selectedProject.environmentId, selectedProject.id);
        const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
          selectedProject,
          projectGroupingSettings,
        );
        const draftId = newDraftId();
        const threadId = newThreadId();
        const { setLogicalProjectDraftThreadId, setModelSelection } =
          useComposerDraftStore.getState();
        // Force "local" (no worktree): the on-disk session was recorded under
        // the project's own workspaceRoot, and Claude's `--resume` is scoped
        // to the exact cwd it was created in — a worktree would run Claude
        // from a different directory and the resume would silently miss.
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt: new Date().toISOString(),
          branch: null,
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
        });
        // Force the draft onto the same Claude instance the session list came
        // from — otherwise the draft could inherit a carried-over/sticky
        // selection for a different provider, and the resume would be
        // rejected once the first message is sent.
        setModelSelection(
          draftId,
          { instanceId: claudeInstanceId, model: claudeModel },
          { replaceOptions: true },
        );
        setResumeSessionIntent(threadId, sessionId);
        await router.navigate({ to: "/draft/$draftId", params: { draftId } });
        handleClose(false);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to resume session",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } finally {
        setIsResuming(false);
      }
    },
    [
      selectedProject,
      claudeInstanceId,
      claudeModel,
      isResuming,
      projectGroupingSettings,
      router,
      setResumeSessionIntent,
      handleClose,
    ],
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
              {!claudeInstanceId || !claudeModel ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No Claude Code provider is configured for this environment.
                </p>
              ) : sessionsPending ? (
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
