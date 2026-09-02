import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-env-mode");

const seedProjectCreated = (sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`evt-project-env-mode-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make(`cmd-project-env-mode-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-project-env-mode-${sequence}`),
  metadata: {},
  payload: {
    projectId,
    title: "Env mode",
    workspaceRoot: "/tmp/env-mode",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

it.layer(NodeServices.layer)("decider project defaults", (it) => {
  it.effect("only treats metadata updates as explicit model defaults", () =>
    Effect.gen(function* () {
      const selection: ModelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      const created = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-model-create"),
          projectId,
          title: "Model default",
          workspaceRoot: "/tmp/model-default",
          defaultModelSelection: selection,
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      });
      const createdEvent = Array.isArray(created) ? created[0] : created;
      expect(createdEvent.type).toBe("project.created");
      expect(
        (createdEvent.payload as { defaultModelSelection?: unknown }).defaultModelSelection,
      ).toBeNull();

      const withProject = yield* projectEvent(createEmptyReadModel(now), {
        ...createdEvent,
        sequence: 1,
      });
      const updated = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-model-update"),
          projectId,
          defaultModelSelection: selection,
        },
        readModel: withProject,
      });
      const updatedEvent = Array.isArray(updated) ? updated[0] : updated;
      expect(updatedEvent.type).toBe("project.meta-updated");
      expect(
        (updatedEvent.payload as { defaultModelSelection?: unknown }).defaultModelSelection,
      ).toEqual(selection);
    }),
  );

  it.effect("propagates defaultThreadEnvMode through meta.update into the read model", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), seedProjectCreated(1));
      expect(readModel.projects[0]?.defaultThreadEnvMode).toBeNull();

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-env-mode-set"),
          projectId,
          defaultThreadEnvMode: "worktree",
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { defaultThreadEnvMode?: unknown }).defaultThreadEnvMode).toBe(
        "worktree",
      );

      const updated = yield* projectEvent(readModel, { ...event, sequence: 2 });
      expect(updated.projects[0]?.defaultThreadEnvMode).toBe("worktree");
    }),
  );

  it.effect("omits the field when unset and clears it on explicit null", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), seedProjectCreated(1));

      const unrelated = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-env-mode-title"),
          projectId,
          title: "Renamed",
        },
        readModel,
      });
      const unrelatedEvent = Array.isArray(unrelated) ? unrelated[0] : unrelated;
      expect("defaultThreadEnvMode" in (unrelatedEvent.payload as object)).toBe(false);

      const set = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-env-mode-set"),
          projectId,
          defaultThreadEnvMode: "worktree",
        },
        readModel,
      });
      const setEvent = Array.isArray(set) ? set[0] : set;
      const afterSet = yield* projectEvent(readModel, { ...setEvent, sequence: 2 });

      const clear = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-env-mode-clear"),
          projectId,
          defaultThreadEnvMode: null,
        },
        readModel: afterSet,
      });
      const clearEvent = Array.isArray(clear) ? clear[0] : clear;
      const afterClear = yield* projectEvent(afterSet, { ...clearEvent, sequence: 3 });
      expect(afterClear.projects[0]?.defaultThreadEnvMode).toBeNull();
    }),
  );
});
