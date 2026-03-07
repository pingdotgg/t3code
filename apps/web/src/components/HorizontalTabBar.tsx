import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useStore } from "../store";
import { useComposerDraftStore } from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { DEFAULT_RUNTIME_MODE } from "../types";
import { isElectron } from "../env";
import type { Thread, Project } from "../types";
import { derivePendingApprovals } from "../session-logic";

interface TabThread {
  id: ThreadId;
  title: string;
  session: Thread["session"] | null;
  activities: Thread["activities"];
  createdAt: string;
  isDraft: boolean;
}

function statusDot(thread: TabThread, hasPendingApproval: boolean): string | null {
  if (hasPendingApproval) return "bg-amber-500";
  if (thread.session?.status === "running" || thread.session?.status === "connecting")
    return "bg-sky-500 animate-pulse";
  return null;
}

const Tab = memo(function Tab({
  thread,
  isActive,
  hasPendingApproval,
  onSelect,
}: {
  thread: TabThread;
  isActive: boolean;
  hasPendingApproval: boolean;
  onSelect: (id: ThreadId) => void;
}) {
  const dot = statusDot(thread, hasPendingApproval);

  return (
    <button
      type="button"
      data-active={isActive || undefined}
      className={`group relative flex h-full max-w-[200px] min-w-[100px] shrink items-center gap-1.5 border-r border-border px-3 text-left transition-colors ${
        isActive
          ? "bg-background text-foreground"
          : "bg-card/50 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      }`}
      onClick={() => onSelect(thread.id)}
    >
      {dot && <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />}
      <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
      {isActive && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
      )}
    </button>
  );
});

const ProjectDropdown = memo(function ProjectDropdown({
  projects,
  activeProjectId,
  onSelect,
}: {
  projects: Project[];
  activeProjectId: ProjectId | null;
  onSelect: (id: ProjectId) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });
  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        popupRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [open]);

  const toggle = useCallback(() => {
    setOpen((v) => {
      if (!v && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setPopupPos({ top: rect.bottom, left: rect.left });
      }
      return !v;
    });
  }, []);

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        className="flex h-full items-center gap-1.5 border-r border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
        onClick={toggle}
      >
        <span className="max-w-[140px] truncate">
          {activeProject?.name ?? "Select project"}
        </span>
        <ChevronDownIcon className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            className="fixed z-[9999] min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-lg"
            style={{
              top: popupPos.top,
              left: popupPos.left,
              WebkitAppRegion: "no-drag",
            } as React.CSSProperties}
          >
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
                  project.id === activeProjectId ? "font-medium text-foreground" : "text-muted-foreground"
                }`}
                onClick={() => {
                  onSelect(project.id);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {project.id === activeProjectId && (
                  <span className="size-1.5 rounded-full bg-primary" />
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
});

export default function HorizontalTabBar() {
  const projects = useStore((s) => s.projects);
  const threads = useStore((s) => s.threads);
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const setProjectDraftThreadId = useComposerDraftStore((s) => s.setProjectDraftThreadId);
  const getDraftThread = useComposerDraftStore((s) => s.getDraftThread);
  const draftThreadsByThreadId = useComposerDraftStore((s) => s.draftThreadsByThreadId);

  const activeThread = threads.find((t) => t.id === routeThreadId);
  const draftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? projects[0]?.id ?? null;

  const projectThreads = useMemo(() => {
    const persistedThreadIds = new Set<ThreadId>();
    const tabThreads: TabThread[] = threads
      .filter((t) => t.projectId === activeProjectId)
      .map((t) => {
        persistedThreadIds.add(t.id);
        return {
          id: t.id,
          title: t.title,
          session: t.session,
          activities: t.activities,
          createdAt: t.createdAt,
          isDraft: false,
        };
      });

    for (const [threadId, draft] of Object.entries(draftThreadsByThreadId)) {
      const tid = ThreadId.makeUnsafe(threadId);
      if (draft.projectId === activeProjectId && !persistedThreadIds.has(tid)) {
        tabThreads.push({
          id: tid,
          title: "New thread",
          session: null,
          activities: [],
          createdAt: draft.createdAt,
          isDraft: true,
        });
      }
    }

    return tabThreads.toSorted((a, b) => {
      const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
    });
  }, [threads, activeProjectId, draftThreadsByThreadId]);

  const pendingApprovalByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of projectThreads) {
      map.set(thread.id, thread.isDraft ? false : derivePendingApprovals(thread.activities).length > 0);
    }
    return map;
  }, [projectThreads]);

  const selectThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );

  const switchProject = useCallback(
    (projectId: ProjectId) => {
      const firstThread = threads
        .filter((t) => t.projectId === projectId)
        .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      if (firstThread) {
        void navigate({ to: "/$threadId", params: { threadId: firstThread.id } });
      }
    },
    [navigate, threads],
  );

  const addNewThread = useCallback(() => {
    if (!activeProjectId) return;
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    setProjectDraftThreadId(activeProjectId, threadId, {
      createdAt,
      branch: null,
      worktreePath: null,
      envMode: "local",
      runtimeMode: DEFAULT_RUNTIME_MODE,
    });
    void navigate({ to: "/$threadId", params: { threadId } });
  }, [activeProjectId, navigate, setProjectDraftThreadId]);

  return (
    <div
      className={`relative z-10 flex h-9 shrink-0 items-stretch border-b border-border bg-card ${
        isElectron ? "drag-region" : ""
      }`}
    >
      {isElectron && <div className="w-[78px] shrink-0" />}

      <ProjectDropdown
        projects={projects}
        activeProjectId={activeProjectId}
        onSelect={switchProject}
      />

      <div
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
        style={{ scrollbarWidth: "none" }}
      >
        {projectThreads.map((thread) => (
          <Tab
            key={thread.id}
            thread={thread}
            isActive={routeThreadId === thread.id}
            hasPendingApproval={pendingApprovalByThreadId.get(thread.id) === true}
            onSelect={selectThread}
          />
        ))}
        <button
          type="button"
          aria-label="New thread"
          className="flex shrink-0 items-center justify-center px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={addNewThread}
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
