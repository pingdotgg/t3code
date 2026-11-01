import type { EditorViewState } from "@pierre/diffs/edit";
import { useAtomValue } from "@effect/atom-react";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  type EnvironmentId,
  type ScopedThreadRef,
  type TaskDocumentId,
} from "@t3tools/contracts";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";
import { Link, useNavigate } from "@tanstack/react-router";
import { CodeIcon, EyeIcon, MaximizeIcon, PencilIcon, PlusIcon, SaveIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import {
  createFileEditor,
  editableFileContents,
  useEditableAfterHighlight,
} from "~/components/files/FilePreviewPanel";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjects } from "~/state/entities";
import { readTaskUpdateInstructionsPath, taskDocumentEnvironment } from "~/state/taskDocuments";
import { useAtomCommand } from "~/state/use-atom-command";

import { TaskPropertiesDialog } from "./TaskPropertiesDialog";
import { TaskRelinkDialog } from "./TaskRelinkDialog";
import { type TaskSession, useTaskCatalogue, useTaskDocument } from "./useTaskDocuments";

const splitDocumentPath = (path: string) => {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { directory: path.slice(0, Math.max(separator, 0)), name: path.slice(separator + 1) };
};

// Windows paths compare case-insensitively; a drive letter is the only signal on this side of the wire.
const samePath = (a: string, b: string) => {
  const normalize = (path: string) => {
    const slashed = path.replaceAll("\\", "/");
    return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
  };
  return normalize(a) === normalize(b);
};

function TaskSourceEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly taskDocumentId: TaskDocumentId;
  readonly name: string;
  readonly contents: string;
  readonly editable: boolean;
  readonly session: TaskSession;
}) {
  const { resolvedTheme } = useTheme();
  const toFile = (contents: string) =>
    editableFileContents(props.environmentId, props.taskDocumentId, props.name, contents);
  // Same rule as the file editor: only changes the editor did not make itself replace its file.
  const [externalFile, setExternalFile] = useState(() => toFile(props.contents));
  const [editedContents, setEditedContents] = useState<string | null>(null);
  if (props.contents !== (editedContents ?? externalFile.contents)) {
    setExternalFile(toFile(props.contents));
    setEditedContents(null);
  }
  const { ready, onPostRender } = useEditableAfterHighlight(externalFile);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<(() => EditorViewState) | null>(null);
  const scrollRestored = useRef(false);
  const { session } = props;
  const [initialView] = useState(() => session.getSnapshot().view);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the editor's DOM-owned cursor and scroll while it is still attached, before unmount removes them
  useLayoutEffect(
    () => () => {
      const editor = editorViewRef.current?.();
      const scroller = surfaceRef.current?.querySelector(".file-preview-virtualizer");
      if (editor) session.setView({ editor, scrollTop: scroller?.scrollTop ?? 0 });
    },
    [session],
  );
  return (
    <EditProvider createEditor={createFileEditor}>
      <div ref={surfaceRef} className="flex min-h-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File
            file={externalFile}
            edit={ready && props.editable}
            editorOptions={{
              onAttach: (editor) => {
                editorViewRef.current = () => editor.getViewState();
                if (initialView.editor) editor.setViewState(initialView.editor);
              },
            }}
            onEditChange={({ file }) => {
              if (file.contents === props.contents) return;
              setEditedContents(file.contents);
              session.edit(file.contents);
            }}
            options={{
              disableFileHeader: true,
              overflow: "wrap",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
              onPostRender: (fileContainer, instance, phase) => {
                onPostRender(instance.file, phase);
                if (scrollRestored.current || phase === "unmount") return;
                scrollRestored.current = true;
                const scroller = fileContainer.closest(".file-preview-virtualizer");
                if (scroller) scroller.scrollTop = initialView.scrollTop;
              },
            }}
            className="min-h-full"
          />
        </Virtualizer>
      </div>
    </EditProvider>
  );
}

function TaskRenderedDocument(props: {
  readonly environmentId: EnvironmentId;
  readonly directory: string;
  readonly text: string;
  readonly session: TaskSession;
  readonly onOpenFileLink: (path: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { session } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores and captures the scroll position the DOM owns, around mount and unmount
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = session.getSnapshot().view.scrollTop;
    return () => {
      if (scroller) session.setView({ scrollTop: scroller.scrollTop });
    };
  }, [session]);
  return (
    <div ref={scrollerRef} className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
      <ChatMarkdown
        text={maskMarkdownFrontmatter(props.text)}
        cwd={props.directory}
        imageBaseDir={props.directory}
        environmentId={props.environmentId}
        onOpenFileLink={props.onOpenFileLink}
        className="mx-auto max-w-4xl px-6 py-5"
      />
    </div>
  );
}

function Notice(props: { readonly children: ReactNode; readonly actions?: ReactNode }) {
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/60 px-3 py-1.5 text-xs"
    >
      <span className="min-w-0 flex-1">{props.children}</span>
      {props.actions}
    </div>
  );
}

const INITIALIZATION_LABELS = {
  pending: "Reading task…",
  running: "Reading task…",
  ready: "Task context ready",
  failed: "Could not read task",
} as const;

function TaskInitializationStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly taskDocumentId: TaskDocumentId;
  readonly thread: EnvironmentThreadShell;
}) {
  const launch = useAtomCommand(taskDocumentEnvironment.launch, { reportFailure: false });
  const canLaunch = useAtomValue(
    taskDocumentEnvironment.launch.permissionAtom(props.environmentId, {
      task: { taskDocumentId: props.taskDocumentId },
    }),
  );
  const [retrying, setRetrying] = useState(false);
  const status = props.thread.taskInitialization?.status;
  if (!status) return null;
  const retry = async () => {
    const updateInstructionsPath = readTaskUpdateInstructionsPath(props.environmentId);
    if (!updateInstructionsPath) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Set the update instructions file",
          description: "Choose it from the Task menu on a new thread, then retry.",
        }),
      );
      return;
    }
    setRetrying(true);
    const result = await launch({
      environmentId: props.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        task: { taskDocumentId: props.taskDocumentId, updateInstructionsPath },
        retryTaskInitialization: true,
        threadId: props.thread.id,
        projectId: props.thread.projectId,
        title: props.thread.title,
        modelSelection: props.thread.modelSelection,
        runtimeMode: props.thread.runtimeMode,
        interactionMode: props.thread.interactionMode,
        // The server keeps a retried thread's own worktree in place of this.
        workspaceStrategy: {
          type: "root",
          ...(props.thread.branch === null ? {} : { branch: props.thread.branch }),
        },
      },
    });
    setRetrying(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not retry",
          description: failure instanceof Error ? failure.message : "An error occurred.",
        }),
      );
    }
  };
  return (
    <Notice
      actions={
        status === "failed" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={retrying || !canLaunch}
            onClick={() => void retry()}
          >
            Retry
          </Button>
        ) : null
      }
    >
      {INITIALIZATION_LABELS[status]}
      {status === "failed" ? ". Queued messages wait until it succeeds." : ""}
    </Notice>
  );
}

export default function TaskDocumentPane(props: {
  readonly environmentId: EnvironmentId;
  readonly taskDocumentId: TaskDocumentId;
  /** The thread showing this document. Absent on the task's own page. */
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly thread?: EnvironmentThreadShell | undefined;
  /** Leaves room for the window's panel controls, which float over a pinned pane's first row. */
  readonly reserveTitlebarControls?: boolean;
  readonly showOpenPage?: boolean;
}) {
  const { environmentId, taskDocumentId, threadRef, thread } = props;
  const { session, state, supported, canRead, canSave, save } = useTaskDocument(
    environmentId,
    taskDocumentId,
  );
  const { tasks, canRelink } = useTaskCatalogue(environmentId);
  const navigate = useNavigate();
  const projects = useProjects();
  const { openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const [showDisk, setShowDisk] = useState(false);
  const [showProperties, setShowProperties] = useState(false);
  const [showRelink, setShowRelink] = useState(false);
  const { base, draft, disk, recovery, error, saving, view } = state;
  const summary = base?.summary ?? null;
  const catalogueTask = tasks.find((candidate) => candidate.taskDocumentId === taskDocumentId);
  const relinkTask = summary ?? catalogueTask;
  const { directory, name } = splitDocumentPath(summary?.canonicalPath ?? "");
  const dirty = base !== null && draft !== base.contents;

  const onOpenFileLink = (path: string) => {
    const task = tasks.find((candidate) => samePath(candidate.canonicalPath, path));
    if (task) {
      void navigate({
        to: "/task/$environmentId/$taskDocumentId",
        params: { environmentId, taskDocumentId: task.taskDocumentId },
      });
      return;
    }
    // A thread can show any host path read-only; the task's own page has nowhere to.
    if (threadRef) {
      useRightPanelStore.getState().openFile(threadRef, path);
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Not a registered task",
        description: path,
      }),
    );
  };

  const startThread = async () => {
    const project =
      projects.find(
        (candidate) =>
          candidate.environmentId === environmentId && candidate.id === thread?.projectId,
      ) ?? (await openScratchProject(environmentId));
    if (project) {
      await handleNewThread(scopeProjectRef(environmentId, project.id), { taskDocumentId });
    }
  };

  if (!canRead) {
    return (
      <p className="m-auto p-6 text-center text-muted-foreground text-sm">
        {supported
          ? "You do not have permission to read task documents on this environment."
          : "This environment does not support task documents."}
      </p>
    );
  }
  if (base === null) {
    const canRelinkMissing =
      relinkTask != null &&
      (relinkTask.availability === "missing" || relinkTask.availability === "identity-changed");
    return error ? (
      <section className="m-auto flex max-w-xl flex-col items-center gap-3 p-6 text-center">
        <h2 className="font-medium text-base">{relinkTask?.title ?? "Task file unavailable"}</h2>
        <p role="alert" className="text-muted-foreground text-sm">
          {relinkTask?.availability === "missing"
            ? "This task file is missing from its saved path."
            : error}
        </p>
        {relinkTask ? (
          <code className="max-w-full break-all text-muted-foreground text-xs">
            {relinkTask.canonicalPath}
          </code>
        ) : null}
        {canRelinkMissing ? (
          canRelink ? (
            <Button size="sm" variant="outline" onClick={() => setShowRelink(true)}>
              Relink task file
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">
              You do not have permission to relink task files on this environment.
            </p>
          )
        ) : null}
        {showRelink && relinkTask ? (
          <TaskRelinkDialog
            environmentId={environmentId}
            task={relinkTask}
            onRelink={(document) => session.acceptRead(session.beginRead(), document)}
            onClose={() => setShowRelink(false)}
          />
        ) : null}
      </section>
    ) : (
      <div className="m-auto p-6">
        <Spinner />
      </div>
    );
  }
  return (
    <section
      aria-label={`Task document: ${summary?.title}`}
      data-task-document-pane
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (summary?.availability === "available") void save();
        }
      }}
    >
      <header
        className={`flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1.5 border-b border-border pl-3 ${props.reserveTitlebarControls ? "pr-28" : "pr-2"}`}
      >
        <Tooltip>
          <TooltipTrigger render={<div className="flex min-w-0 flex-1 items-baseline gap-2" />}>
            <h2 className="truncate font-medium text-sm">{summary?.title}</h2>
            {summary?.state ? (
              <span className="shrink-0 text-muted-foreground text-xs">{summary.state}</span>
            ) : null}
            {dirty ? <span className="shrink-0 text-muted-foreground text-xs">Edited</span> : null}
          </TooltipTrigger>
          <TooltipPopup>{summary?.canonicalPath}</TooltipPopup>
        </Tooltip>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-pressed={view.rendered}
          aria-label={view.rendered ? "Edit source" : "Show rendered Markdown"}
          title={view.rendered ? "Edit source" : "Show rendered Markdown"}
          onClick={() => session.setView({ rendered: !view.rendered })}
        >
          {view.rendered ? <CodeIcon /> : <EyeIcon />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Save task document"
          title="Save task document"
          disabled={
            !canSave || summary?.availability !== "available" || !dirty || disk !== null || saving
          }
          onClick={() => void save()}
        >
          {saving ? <Spinner /> : <SaveIcon />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Edit task properties"
          title="Edit task properties"
          disabled={!canSave || summary?.availability !== "available" || disk !== null}
          onClick={() => setShowProperties(true)}
        >
          <PencilIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="New thread in this task"
          title="New thread in this task"
          onClick={() => void startThread()}
        >
          <PlusIcon />
        </Button>
        {props.showOpenPage ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open task page"
            title="Open task page"
            render={
              <Link
                to="/task/$environmentId/$taskDocumentId"
                params={{ environmentId, taskDocumentId }}
              />
            }
          >
            <MaximizeIcon />
          </Button>
        ) : null}
      </header>
      {thread ? (
        <TaskInitializationStatus
          environmentId={environmentId}
          taskDocumentId={taskDocumentId}
          thread={thread}
        />
      ) : null}
      {summary?.availability === "identity-changed" ? (
        <Notice
          actions={
            canRelink ? (
              <Button size="xs" variant="outline" onClick={() => setShowRelink(true)}>
                Relink task file
              </Button>
            ) : null
          }
        >
          This file has a different task ID. Relink it to keep this task's threads attached before
          editing.
          {!canRelink ? " You do not have permission to relink task files here." : ""}
        </Notice>
      ) : null}
      {error ? <Notice>{error} Your draft is kept.</Notice> : null}
      {!canSave ? <Notice>You can read this task but not edit it here.</Notice> : null}
      {disk !== null ? (
        <Notice
          actions={
            <>
              <Button size="xs" variant="outline" onClick={() => setShowDisk(!showDisk)}>
                {showDisk ? "Hide disk version" : "Show disk version"}
              </Button>
              <Button size="xs" variant="outline" onClick={() => session.keepDraft()}>
                Keep my draft
              </Button>
              <Button size="xs" variant="outline" onClick={() => session.reloadDisk()}>
                Use disk version
              </Button>
            </>
          }
        >
          This file changed on disk while you were editing. Choose which version to continue from.
        </Notice>
      ) : null}
      {disk !== null && showDisk ? (
        <pre className="max-h-1/2 shrink-0 overflow-auto border-b border-border p-3 text-xs">
          {disk.contents}
        </pre>
      ) : null}
      {recovery !== null ? (
        <Notice
          actions={
            <>
              <Button size="xs" variant="outline" onClick={() => session.reverseRecovery()}>
                {recovery.keptDraft ? "Use disk version" : "Restore my draft"}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => session.dismissRecovery()}>
                Dismiss
              </Button>
            </>
          }
        >
          {recovery.keptDraft
            ? "Saving will replace the disk version."
            : "Continuing from the disk version. Your earlier draft is still available."}
        </Notice>
      ) : null}
      {view.rendered ? (
        <TaskRenderedDocument
          key={`${environmentId}:${taskDocumentId}`}
          environmentId={environmentId}
          directory={directory}
          text={draft}
          session={session}
          onOpenFileLink={onOpenFileLink}
        />
      ) : (
        <DiffWorkerPoolProvider>
          <TaskSourceEditor
            key={`${environmentId}:${taskDocumentId}`}
            environmentId={environmentId}
            taskDocumentId={taskDocumentId}
            name={name}
            contents={draft}
            editable={canSave && summary?.availability === "available" && disk === null}
            session={session}
          />
        </DiffWorkerPoolProvider>
      )}
      {showProperties && summary ? (
        <TaskPropertiesDialog
          contents={draft}
          title={summary.title}
          state={summary.state}
          pinned={summary.pinned}
          onApply={(contents) => session.edit(contents)}
          onClose={() => setShowProperties(false)}
        />
      ) : null}
      {showRelink && relinkTask ? (
        <TaskRelinkDialog
          environmentId={environmentId}
          task={relinkTask}
          onRelink={(document) => session.acceptRead(session.beginRead(), document)}
          onClose={() => setShowRelink(false)}
        />
      ) : null}
    </section>
  );
}
