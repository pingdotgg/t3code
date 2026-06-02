import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type EnvironmentId as EnvironmentIdType,
  type ProjectId as ProjectIdType,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";

export function scopeProjectRef(
  environmentId: EnvironmentIdType,
  projectId: ProjectIdType,
): ScopedProjectRef {
  return { environmentId, projectId };
}

export function scopeThreadRef(
  environmentId: EnvironmentIdType,
  threadId: ThreadId,
): ScopedThreadRef {
  return { environmentId, threadId };
}

export function scopedRefKey(ref: ScopedProjectRef | ScopedThreadRef): string {
  const localId = "projectId" in ref ? ref.projectId : ref.threadId;
  return `${ref.environmentId}:${localId}`;
}

export function scopedProjectKey(ref: ScopedProjectRef): string {
  return scopedRefKey(ref);
}

export function scopedThreadKey(ref: ScopedThreadRef): string {
  return scopedRefKey(ref);
}

function parseScopedKey(key: string): { environmentId: EnvironmentIdType; localId: string } | null {
  const separatorIndex = key.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
    return null;
  }
  return {
    environmentId: EnvironmentId.make(key.slice(0, separatorIndex)),
    localId: key.slice(separatorIndex + 1),
  };
}

export function parseScopedProjectKey(key: string): ScopedProjectRef | null {
  const parsed = parseScopedKey(key);
  if (!parsed) {
    return null;
  }
  return {
    environmentId: parsed.environmentId,
    projectId: ProjectId.make(parsed.localId),
  };
}

export function parseScopedThreadKey(key: string): ScopedThreadRef | null {
  const parsed = parseScopedKey(key);
  if (!parsed) {
    return null;
  }
  return {
    environmentId: parsed.environmentId,
    threadId: ThreadId.make(parsed.localId),
  };
}
