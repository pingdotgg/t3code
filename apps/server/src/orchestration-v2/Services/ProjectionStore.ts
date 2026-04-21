import {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export class ProjectionStoreApplyEventError extends Schema.TaggedErrorClass<ProjectionStoreApplyEventError>()(
  "ProjectionStoreApplyEventError",
  {
    eventType: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to apply orchestration projection event ${this.eventType}.`;
  }
}

export class ProjectionStoreThreadNotFoundError extends Schema.TaggedErrorClass<ProjectionStoreThreadNotFoundError>()(
  "ProjectionStoreThreadNotFoundError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `No orchestration projection exists for thread ${this.threadId}.`;
  }
}

export class ProjectionStoreReadError extends Schema.TaggedErrorClass<ProjectionStoreReadError>()(
  "ProjectionStoreReadError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to read orchestration projection for thread ${this.threadId}.`;
  }
}

export const ProjectionStoreV2Error = Schema.Union([
  ProjectionStoreApplyEventError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreReadError,
]);
export type ProjectionStoreV2Error = typeof ProjectionStoreV2Error.Type;

export interface ProjectionStoreV2Shape {
  readonly apply: (
    event: OrchestrationV2DomainEvent,
  ) => Effect.Effect<void, ProjectionStoreV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
}

export class ProjectionStoreV2 extends Context.Service<ProjectionStoreV2, ProjectionStoreV2Shape>()(
  "t3/orchestration-v2/Services/ProjectionStore",
) {}
