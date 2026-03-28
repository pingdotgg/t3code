import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { DraftThreadState } from "./composerDraftStore";
import { sortThreadsForSidebar } from "./components/Sidebar.logic";
import type { Project, Thread } from "./types";

export type ProjectRouteTarget =
  | {
      kind: "missing";
    }
  | {
      kind: "empty";
      project: Project;
    }
  | {
      kind: "thread";
      project: Project;
      threadId: ThreadId;
    };

export function resolveProjectRouteTarget(input: {
  projectId: ProjectId;
  projects: readonly Project[];
  threads: readonly Thread[];
  threadSortOrder: SidebarThreadSortOrder;
}): ProjectRouteTarget {
  const project = input.projects.find((candidate) => candidate.id === input.projectId);
  if (!project) {
    return { kind: "missing" };
  }

  const latestThread = sortThreadsForSidebar(
    input.threads.filter((thread) => thread.projectId === input.projectId),
    input.threadSortOrder,
  )[0];

  if (!latestThread) {
    return {
      kind: "empty",
      project,
    };
  }

  return {
    kind: "thread",
    project,
    threadId: latestThread.id,
  };
}

export type ThreadRouteTarget =
  | {
      kind: "missing";
    }
  | {
      kind: "thread";
      projectId: ProjectId;
      threadId: ThreadId;
    };

export function resolveThreadRouteTarget(input: {
  threadId: ThreadId;
  threads: readonly Thread[];
  draftThreadsByThreadId: Readonly<Record<ThreadId, DraftThreadState>>;
}): ThreadRouteTarget {
  const thread = input.threads.find((candidate) => candidate.id === input.threadId);
  if (thread) {
    return {
      kind: "thread",
      projectId: thread.projectId,
      threadId: thread.id,
    };
  }

  const draftThread = input.draftThreadsByThreadId[input.threadId];
  if (draftThread) {
    return {
      kind: "thread",
      projectId: draftThread.projectId,
      threadId: input.threadId,
    };
  }

  return { kind: "missing" };
}
