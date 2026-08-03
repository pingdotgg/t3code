import {
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

type ShellStreamProjectionQuery = Pick<
  ProjectionSnapshotQueryShape,
  "getProjectShellById" | "getThreadShellById"
>;

export function filterActiveShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
): OrchestrationShellSnapshot {
  const threads = snapshot.threads.filter((thread) => thread.archivedAt === null);
  return threads.length === snapshot.threads.length ? snapshot : { ...snapshot, threads };
}

export function toShellStreamEvent(
  projectionSnapshotQuery: ShellStreamProjectionQuery,
  event: OrchestrationEvent,
): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never> {
  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
      return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
        Effect.map((project) =>
          Option.map(project, (nextProject) => ({
            kind: "project-upserted" as const,
            sequence: event.sequence,
            project: nextProject,
          })),
        ),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
    case "project.deleted":
      return Effect.succeed(
        Option.some({
          kind: "project-removed" as const,
          sequence: event.sequence,
          projectId: event.payload.projectId,
        }),
      );
    case "thread.deleted":
    case "thread.archived":
      return Effect.succeed(
        Option.some({
          kind: "thread-removed" as const,
          sequence: event.sequence,
          threadId: event.payload.threadId,
        }),
      );
    default:
      if (event.aggregateKind !== "thread") {
        return Effect.succeed(Option.none());
      }
      return projectionSnapshotQuery.getThreadShellById(ThreadId.make(event.aggregateId)).pipe(
        Effect.map((thread) =>
          Option.map(thread, (nextThread) => ({
            kind: "thread-upserted" as const,
            sequence: event.sequence,
            thread: nextThread,
          })),
        ),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
  }
}
