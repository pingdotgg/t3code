import { ProjectId, ThreadId } from "@t3tools/contracts";

const PROJECT_DRAFT_THREADS_STORAGE_KEY = "t3code:project-draft-threads:v1";

type ProjectDraftThreadMap = Record<ProjectId, ThreadId>;

function readAllProjectDraftThreads(): ProjectDraftThreadMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(PROJECT_DRAFT_THREADS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const next: ProjectDraftThreadMap = {};
    for (const [projectId, threadId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof projectId !== "string" || typeof threadId !== "string") {
        continue;
      }
      if (projectId.length === 0 || threadId.length === 0) {
        continue;
      }
      next[projectId as ProjectId] = threadId as ThreadId;
    }
    return next;
  } catch {
    return {};
  }
}

function persistAllProjectDraftThreads(next: ProjectDraftThreadMap): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const entries = Object.entries(next);
    if (entries.length === 0) {
      window.localStorage.removeItem(PROJECT_DRAFT_THREADS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PROJECT_DRAFT_THREADS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort persistence only.
  }
}

export function readProjectDraftThreadId(projectId: ProjectId): ThreadId | null {
  if (projectId.length === 0) {
    return null;
  }
  const all = readAllProjectDraftThreads();
  return all[projectId] ?? null;
}

export function writeProjectDraftThreadId(projectId: ProjectId, threadId: ThreadId): void {
  if (projectId.length === 0 || threadId.length === 0) {
    return;
  }
  const all = readAllProjectDraftThreads();
  all[projectId] = threadId;
  persistAllProjectDraftThreads(all);
}

export function clearProjectDraftThreadId(projectId: ProjectId): void {
  if (projectId.length === 0) {
    return;
  }
  const all = readAllProjectDraftThreads();
  if (all[projectId] === undefined) {
    return;
  }
  const { [projectId]: _removed, ...rest } = all;
  persistAllProjectDraftThreads(rest);
}

export function clearProjectDraftThreadById(projectId: ProjectId, threadId: ThreadId): void {
  if (projectId.length === 0 || threadId.length === 0) {
    return;
  }
  const all = readAllProjectDraftThreads();
  if (all[projectId] !== threadId) {
    return;
  }
  const { [projectId]: _removed, ...rest } = all;
  persistAllProjectDraftThreads(rest);
}
