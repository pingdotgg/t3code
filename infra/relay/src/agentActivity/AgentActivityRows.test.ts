import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { makePgliteRelayDb } from "../persistence/pgliteTestDb.ts";
import { relayAgentActivityRows } from "../persistence/schema.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";

describe("AgentActivityRows", () => {
  it.effect("prunes finished rows after 30 minutes and any row the read side has expired", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-06-01T00:00:00.000Z");
      yield* TestClock.setTime(now);
      const minutesAgo = (minutes: number) =>
        DateTime.formatIso(DateTime.makeUnsafe(now - minutes * 60_000));
      const { db, layer } = yield* makePgliteRelayDb;
      const row = (
        threadId: string,
        phase: RelayAgentActivityState["phase"],
        updatedAt: string,
      ) => ({
        environmentId: "env-1",
        environmentPublicKey: "key-1",
        threadId,
        stateJson: { phase, updatedAt } as RelayAgentActivityState,
        updatedAt,
        createdAt: updatedAt,
      });
      yield* Effect.promise(() =>
        db
          .insert(relayAgentActivityRows)
          .values([
            row("old-completed", "completed", minutesAgo(31)),
            row("recent-completed", "completed", minutesAgo(29)),
            row("abandoned-running", "running", minutesAgo(24 * 60 + 1)),
            row("waiting", "waiting_for_input", minutesAgo(24 * 60 - 1)),
          ]),
      );
      const rows = yield* Effect.service(AgentActivityRows.AgentActivityRows).pipe(
        Effect.provide(AgentActivityRows.layer.pipe(Layer.provide(layer))),
      );

      yield* rows.prune;
      const remaining = yield* Effect.promise(() => db.select().from(relayAgentActivityRows));
      expect(remaining.map((remainingRow) => remainingRow.threadId).toSorted()).toEqual([
        "recent-completed",
        "waiting",
      ]);
    }),
  );
});
