import { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";

export function scopedProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

export function scopedThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

export function scopedRequestKey(
  environmentId: EnvironmentId,
  requestId: RuntimeRequestId,
): string {
  return `${environmentId}:${requestId}`;
}
