import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ApplicationProjectEvent } from "./applicationEvent.ts";

const decodeApplicationProjectEvent = Schema.decodeUnknownEffect(ApplicationProjectEvent);

describe("application project events", () => {
  it.effect("decodes project events without the legacy thread event contract", () =>
    Effect.gen(function* () {
      const event = yield* decodeApplicationProjectEvent({
        sequence: 12,
        eventId: "event-project-12",
        aggregateKind: "project",
        aggregateId: "project-1",
        occurredAt: "2026-06-24T12:00:00.000Z",
        commandId: "command-project-12",
        causationEventId: null,
        correlationId: "command-project-12",
        metadata: {},
        type: "project.created",
        payload: {
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-24T12:00:00.000Z",
          updatedAt: "2026-06-24T12:00:00.000Z",
        },
      });

      expect(event.type).toBe("project.created");
      expect(event.payload.projectId).toBe("project-1");
    }),
  );

  it.effect("rejects a project event carrying a thread aggregate", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeApplicationProjectEvent({
          sequence: 12,
          eventId: "event-project-12",
          aggregateKind: "thread",
          aggregateId: "project-1",
          occurredAt: "2026-06-24T12:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: {
            projectId: "project-1",
            deletedAt: "2026-06-24T12:00:00.000Z",
          },
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );
});
