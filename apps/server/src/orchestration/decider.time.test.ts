import { CommandId, EventId, ProjectId, type OrchestrationEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

it.effect("uses the Effect clock for generated decider timestamps", () =>
  Effect.gen(function* () {
    const frozenAt = "2026-05-07T16:03:00.000Z";
    const projectId = asProjectId("project-clock");

    yield* TestClock.setTime(DateTime.makeUnsafe(frozenAt).epochMilliseconds);

    const readModel = yield* projectEvent(createEmptyReadModel(frozenAt), {
      sequence: 1,
      eventId: asEventId("evt-project-clock-create"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: frozenAt,
      commandId: asCommandId("cmd-project-clock-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project-clock-create"),
      metadata: {},
      payload: {
        projectId,
        title: "Clock",
        workspaceRoot: "/tmp/clock",
        defaultModelSelection: null,
        scripts: [],
        createdAt: frozenAt,
        updatedAt: frozenAt,
      },
    });

    const result = yield* decideOrchestrationCommand({
      command: {
        type: "project.meta.update",
        commandId: asCommandId("cmd-project-clock-update"),
        projectId,
        title: "Clock Updated",
      },
      readModel,
    });

    const events: ReadonlyArray<PlannedEvent> = Array.isArray(result)
      ? (result as ReadonlyArray<PlannedEvent>)
      : [result as PlannedEvent];
    assert.equal(events.length, 1);

    const event = events[0];
    if (event === undefined) {
      assert.fail("Expected a project.meta-updated event.");
    }

    if (event.type !== "project.meta-updated") {
      assert.fail(`Expected project.meta-updated, got ${event.type}`);
    }

    assert.equal(event.occurredAt, frozenAt);
    assert.equal(event.payload.updatedAt, frozenAt);
  }).pipe(Effect.provide(TestClock.layer())),
);
