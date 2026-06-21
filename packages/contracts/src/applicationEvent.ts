import type { OrchestrationEvent } from "./orchestration.ts";
import type { OrchestrationV2StoredEvent } from "./orchestrationV2.ts";

export type ApplicationProjectEvent = Extract<
  OrchestrationEvent,
  {
    readonly type: "project.created" | "project.meta-updated" | "project.deleted";
  }
>;

/** Events exposed by the retained application event source. */
export type ApplicationStoredEvent = ApplicationProjectEvent | OrchestrationV2StoredEvent;
