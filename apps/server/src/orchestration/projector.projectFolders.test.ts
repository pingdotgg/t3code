import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const projectEventOf = (input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  projectId: string;
  payload: unknown;
}): OrchestrationEvent =>
  ({
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "project",
    aggregateId: ProjectId.make(input.projectId),
    occurredAt: now,
    commandId: CommandId.make(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  }) as OrchestrationEvent;

const applyAll = Effect.fn("applyAll")(function* (events: ReadonlyArray<OrchestrationEvent>) {
  let state = createEmptyReadModel(now);
  for (const event of events) {
    state = yield* projectEvent(state, event);
  }
  return state;
});

it.effect("replays historical project.created events without source folders", () =>
  Effect.gen(function* () {
    // Events are immutable and replayed forever: a project created before
    // source folders existed must project as owning none.
    const state = yield* applyAll([
      projectEventOf({
        sequence: 1,
        type: "project.created",
        projectId: "project-legacy",
        payload: {
          projectId: "project-legacy",
          title: "Legacy",
          workspaceRoot: "/tmp/legacy",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    ]);

    assert.deepStrictEqual(state.projects[0]?.additionalFolders, []);
  }),
);

it.effect("projects source folders from project.created", () =>
  Effect.gen(function* () {
    const state = yield* applyAll([
      projectEventOf({
        sequence: 1,
        type: "project.created",
        projectId: "project-multi",
        payload: {
          projectId: "project-multi",
          title: "Multi",
          workspaceRoot: "/repo/app",
          additionalFolders: [{ path: "/repo/docs", label: "Docs" }],
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    ]);

    assert.deepStrictEqual(state.projects[0]?.additionalFolders, [
      { path: "/repo/docs", label: "Docs" },
    ]);
  }),
);

it.effect("leaves source folders untouched when a meta update omits them", () =>
  Effect.gen(function* () {
    const state = yield* applyAll([
      projectEventOf({
        sequence: 1,
        type: "project.created",
        projectId: "project-multi",
        payload: {
          projectId: "project-multi",
          title: "Multi",
          workspaceRoot: "/repo/app",
          additionalFolders: [{ path: "/repo/docs" }],
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
      projectEventOf({
        sequence: 2,
        type: "project.meta-updated",
        projectId: "project-multi",
        payload: { projectId: "project-multi", title: "Renamed", updatedAt: now },
      }),
    ]);

    assert.strictEqual(state.projects[0]?.title, "Renamed");
    assert.deepStrictEqual(state.projects[0]?.additionalFolders, [{ path: "/repo/docs" }]);
  }),
);

it.effect("applies a promotion as a single atomic swap", () =>
  Effect.gen(function* () {
    const state = yield* applyAll([
      projectEventOf({
        sequence: 1,
        type: "project.created",
        projectId: "project-multi",
        payload: {
          projectId: "project-multi",
          title: "Multi",
          workspaceRoot: "/repo/app",
          additionalFolders: [{ path: "/repo/docs" }],
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
      projectEventOf({
        sequence: 2,
        type: "project.meta-updated",
        projectId: "project-multi",
        payload: {
          projectId: "project-multi",
          workspaceRoot: "/repo/docs",
          additionalFolders: [{ path: "/repo/app" }],
          updatedAt: now,
        },
      }),
    ]);

    assert.strictEqual(state.projects[0]?.workspaceRoot, "/repo/docs");
    assert.deepStrictEqual(state.projects[0]?.additionalFolders, [{ path: "/repo/app" }]);
  }),
);
