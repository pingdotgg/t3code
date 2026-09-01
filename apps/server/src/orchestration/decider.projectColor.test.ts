import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);

const seedProject = (now: string) =>
  projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: asEventId("evt-project-create-color"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-color"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-project-create-color"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project-create-color"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-color"),
      title: "Color",
      workspaceRoot: "/tmp/color",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

it.layer(NodeServices.layer)("decider project color", (it) => {
  it.effect("propagates color in project.meta.update payload", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = yield* seedProject(now);

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-color"),
          projectId: asProjectId("project-color"),
          color: "teal",
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { color?: string | null }).color).toBe("teal");
    }),
  );

  it.effect("omits color from the payload when the command leaves it unchanged", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = yield* seedProject(now);

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-title-only"),
          projectId: asProjectId("project-color"),
          title: "Renamed",
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect("color" in (event.payload as object)).toBe(false);
    }),
  );

  it.effect("projects color onto the read model and clears it on null", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = yield* seedProject(now);

      const withColor = yield* projectEvent(readModel, {
        sequence: 2,
        eventId: asEventId("evt-project-color-set"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-color"),
        type: "project.meta-updated",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-color-set"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-color-set"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-color"),
          color: "violet",
          updatedAt: now,
        },
      });
      expect(withColor.projects[0]?.color).toBe("violet");

      const cleared = yield* projectEvent(withColor, {
        sequence: 3,
        eventId: asEventId("evt-project-color-clear"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-color"),
        type: "project.meta-updated",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-color-clear"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-color-clear"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-color"),
          color: null,
          updatedAt: now,
        },
      });
      expect(cleared.projects[0]?.color).toBeNull();
    }),
  );
});
