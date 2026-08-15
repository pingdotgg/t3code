import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  type SyncedClientPreferencesPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function preferenceEvent(input: {
  readonly sequence: number;
  readonly updatedAt: string;
  readonly patch: SyncedClientPreferencesPatch;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`preferences-${input.sequence}`),
    type: "client-preferences.patched",
    aggregateKind: "client-preferences",
    aggregateId: "client-preferences",
    occurredAt: input.updatedAt,
    commandId: CommandId.make(`preferences-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { patch: input.patch, updatedAt: input.updatedAt },
  };
}

it.effect("merges synced preferences by field when a later event is globally stale", () =>
  Effect.gen(function* () {
    const withAppearance = yield* projectEvent(
      createEmptyReadModel("2026-08-14T10:00:00.000Z"),
      preferenceEvent({
        sequence: 1,
        updatedAt: "2026-08-14T13:00:00.000Z",
        patch: { appearanceMode: "dark" },
      }),
    );
    const withPlan = yield* projectEvent(
      withAppearance,
      preferenceEvent({
        sequence: 2,
        updatedAt: "2026-08-14T12:00:00.000Z",
        patch: { planModeEnabled: true },
      }),
    );

    assert.deepEqual(withPlan.syncedClientPreferences, {
      planModeEnabled: true,
      appearanceMode: "dark",
      updatedAtByField: {
        planModeEnabled: "2026-08-14T12:00:00.000Z",
        appearanceMode: "2026-08-14T13:00:00.000Z",
        themeId: "2026-08-14T13:00:00.000Z",
      },
      updatedAt: "2026-08-14T13:00:00.000Z",
    });
    assert.strictEqual(withPlan.updatedAt, "2026-08-14T13:00:00.000Z");
  }),
);

it.effect("backfills field clocks before patching legacy synced preferences", () =>
  Effect.gen(function* () {
    const legacyUpdatedAt = "2026-08-14T10:00:00.000Z";
    const legacyModel = {
      ...createEmptyReadModel(legacyUpdatedAt),
      syncedClientPreferences: {
        planModeEnabled: false,
        appearanceMode: "light" as const,
        themeId: "legacy-theme",
        updatedAt: legacyUpdatedAt,
      },
    };
    const withPlan = yield* projectEvent(
      legacyModel,
      preferenceEvent({
        sequence: 1,
        updatedAt: "2026-08-14T12:00:00.000Z",
        patch: { planModeEnabled: true },
      }),
    );
    const withAppearance = yield* projectEvent(
      withPlan,
      preferenceEvent({
        sequence: 2,
        updatedAt: "2026-08-14T11:00:00.000Z",
        patch: { appearanceMode: "dark" },
      }),
    );

    assert.deepEqual(withAppearance.syncedClientPreferences, {
      planModeEnabled: true,
      appearanceMode: "dark",
      themeId: "legacy-theme",
      updatedAtByField: {
        planModeEnabled: "2026-08-14T12:00:00.000Z",
        appearanceMode: "2026-08-14T11:00:00.000Z",
        themeId: legacyUpdatedAt,
      },
      updatedAt: "2026-08-14T12:00:00.000Z",
    });
  }),
);
