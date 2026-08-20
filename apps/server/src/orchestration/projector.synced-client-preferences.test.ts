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

it.effect("keeps each preference value on its independent field clock", () =>
  Effect.gen(function* () {
    const current = yield* projectEvent(
      createEmptyReadModel("2026-08-14T10:00:00.000Z"),
      preferenceEvent({
        sequence: 1,
        updatedAt: "2026-08-14T13:00:00.000Z",
        patch: {
          planModeEnabled: true,
          appearanceMode: "system",
          lightThemeId: "catppuccin-latte",
          darkThemeId: "dracula",
        },
      }),
    );
    const afterStaleEvent = yield* projectEvent(
      current,
      preferenceEvent({
        sequence: 2,
        updatedAt: "2026-08-14T12:00:00.000Z",
        patch: { planModeEnabled: false },
      }),
    );

    assert.deepEqual(afterStaleEvent.syncedClientPreferences, {
      planModeEnabled: true,
      appearanceMode: "system",
      lightThemeId: "catppuccin-latte",
      darkThemeId: "dracula",
      updatedAtByField: {
        planModeEnabled: "2026-08-14T13:00:00.000Z",
        appearanceMode: "2026-08-14T13:00:00.000Z",
        lightThemeId: "2026-08-14T13:00:00.000Z",
        darkThemeId: "2026-08-14T13:00:00.000Z",
      },
      updatedAt: "2026-08-14T13:00:00.000Z",
    });
  }),
);
