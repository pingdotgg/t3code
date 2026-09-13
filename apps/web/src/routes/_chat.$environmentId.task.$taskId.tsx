import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedTaskKey,
} from "@t3tools/client-runtime/environment";
import type { ScopedTaskRef, ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveDraftPromotionNavigationTarget } from "~/components/ChatView.logic";
import { waitForDraftHeroTransition } from "~/components/chat/draftHeroTransition";
import { TaskPageBody } from "~/components/tasks/TaskPageBody";
import ChatView from "~/components/ChatView";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  createTaskPageDraftPreparation,
  taskPageAvailability,
  taskPageBackgroundDraftTransition,
} from "~/components/tasks/TaskPage.logic";
import {
  type DraftId,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useTaskActions } from "~/hooks/useTaskActions";
import { useArchivedThreadSnapshots } from "~/lib/archivedThreadsState";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { environmentShell } from "~/state/shell";
import { useEnvironment } from "~/state/environments";
import { useTask } from "~/state/tasks";
import { buildThreadRouteParams, resolveTaskRouteRef } from "~/threadRoutes";

type PageDraft = { draftId: DraftId; threadId: ThreadId };

function TaskRouteView() {
  const taskRef = Route.useParams({ select: resolveTaskRouteRef });
  return taskRef ? <TaskRoutePage key={scopedTaskKey(taskRef)} taskRef={taskRef} /> : null;
}

function TaskRoutePage({ taskRef }: { taskRef: ScopedTaskRef }) {
  const task = useTask(taskRef);
  const navigate = useNavigate();
  const environment = useEnvironment(taskRef.environmentId);
  const projects = useProjects();
  const shell = useAtomValue(environmentShell.stateValueAtom(taskRef.environmentId));
  const config = useServerConfigs().get(taskRef.environmentId);
  const supportsTasks = config ? config.environment.capabilities.tasks === true : undefined;
  const archiveEnvironmentIds = useMemo(
    () => (task || supportsTasks !== true ? [] : [taskRef.environmentId]),
    [supportsTasks, task, taskRef.environmentId],
  );
  const archive = useArchivedThreadSnapshots(archiveEnvironmentIds);
  const archivedTask =
    archive.snapshots
      .find((entry) => entry.environmentId === taskRef.environmentId)
      ?.snapshot.tasks?.find((candidate) => candidate.id === taskRef.taskId) ?? null;
  const primaryProject = projects.find(
    (project) =>
      project.environmentId === taskRef.environmentId && project.id === task?.primaryProjectId,
  );
  const state = taskPageAvailability({
    shellStatus: shell.status,
    disconnected:
      environment?.connection.phase === "offline" || environment?.connection.phase === "error",
    supportsTasks,
    task,
    archivedTask,
    archiveLoading: archive.isLoading,
    archiveError: archive.error,
    hasPrimaryProject: primaryProject != null,
  });
  const handleNewThread = useNewThreadHandler();
  const actions = useTaskActions();
  const [draft, setDraft] = useState<{ key: string; value: PageDraft } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [generation, setGeneration] = useState(0);
  const prepare = useRef(createTaskPageDraftPreparation<PageDraft | null>());
  const key = `${scopedTaskKey(taskRef)}:${primaryProject?.id ?? ""}:${generation}`;
  const currentDraft = draft?.key === key ? draft.value : null;
  const error = failure?.key === key ? failure.message : null;
  const threadRef = useMemo(
    () => (currentDraft ? scopeThreadRef(taskRef.environmentId, currentDraft.threadId) : null),
    [currentDraft, taskRef.environmentId],
  );
  const thread = useThreadShell(threadRef);
  const session = useComposerDraftStore((store) =>
    currentDraft ? store.getDraftSession(currentDraft.draftId) : null,
  );
  const backgroundPending = useBackgroundDraftSubmissionPending(threadRef);
  const [backgroundDraftId, setBackgroundDraftId] = useState<DraftId | null>(null);
  if (backgroundPending && currentDraft && backgroundDraftId !== currentDraft.draftId)
    setBackgroundDraftId(currentDraft.draftId);
  const wasBackground = currentDraft != null && backgroundDraftId === currentDraft.draftId;
  const backgroundTransition = taskPageBackgroundDraftTransition({
    wasBackground,
    backgroundPending,
    threadExists: thread != null,
  });
  if (backgroundTransition === "next-draft") {
    setDraft(null);
    setGeneration((value) => value + 1);
  } else if (backgroundTransition === "failed") setBackgroundDraftId(null);
  const navigationTarget = resolveDraftPromotionNavigationTarget({
    serverThreadRef: threadRef,
    serverThread: thread,
    backgroundSubmissionPending: backgroundPending || wasBackground,
  });
  useEffect(() => {
    if (thread && threadRef && !session?.promotedTo) markPromotedDraftThreadByRef(threadRef);
  }, [session?.promotedTo, thread, threadRef]);
  useEffect(() => {
    if (!navigationTarget) return;
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (!cancelled)
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(navigationTarget),
          replace: true,
        });
    });
    return () => {
      cancelled = true;
    };
  }, [navigate, navigationTarget]);
  useEffect(() => {
    if (state !== "ready" || !primaryProject) return;
    let cancelled = false;
    void prepare
      .current(key, () =>
        handleNewThread(scopeProjectRef(taskRef.environmentId, primaryProject.id), {
          taskId: taskRef.taskId,
          navigate: false,
        }),
      )
      .then(
        (value) => {
          if (cancelled) return;
          if (value) setDraft({ key, value });
          else
            setFailure({
              key,
              message: "Could not prepare a thread. Retry when this environment is available.",
            });
        },
        (reason: unknown) => {
          if (!cancelled)
            setFailure({
              key,
              message: reason instanceof Error ? reason.message : "Could not prepare a thread.",
            });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [handleNewThread, key, primaryProject, state, taskRef.environmentId, taskRef.taskId]);

  const showComposer = (state === "ready" || state === "cached") && currentDraft;
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {showComposer ? (
        <>
          {state === "cached" ? (
            <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
              Showing saved task data. Reconnect to make changes.
            </p>
          ) : null}
          <ChatView
            routeKind="draft"
            draftId={currentDraft.draftId}
            environmentId={taskRef.environmentId}
            threadId={currentDraft.threadId}
            taskPage={taskRef}
          />
        </>
      ) : state === "project-missing" ? (
        <>
          <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
            This task’s primary project is unavailable. Choose another project to continue.
          </p>
          <TaskPageBody taskRef={taskRef} />
        </>
      ) : (
        <div className="m-auto flex max-w-lg flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <p>
            {error ??
              (state === "archived"
                ? `“${(task ?? archivedTask)?.name ?? "Task"}” is archived.`
                : state === "unsupported"
                  ? "This environment does not support tasks."
                  : state === "missing"
                    ? "This task no longer exists."
                    : state === "disconnected" || state === "cached"
                      ? "Reconnect to load this task."
                      : state === "archive-error"
                        ? archive.error
                        : "Loading task…")}
          </p>
          {state === "archived" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void actions.unarchiveTask(taskRef).then((result) => {
                  if (result._tag === "Success") archive.refresh();
                });
              }}
            >
              Unarchive task and threads
            </Button>
          ) : null}
          {error || state === "archive-error" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                archive.refresh();
                setGeneration((value) => value + 1);
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/task/$taskId")({
  component: TaskRouteView,
});
