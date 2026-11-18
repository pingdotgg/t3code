import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { reviewTurnDiffsBySectionId } from "../features/review/reviewModel";
import {
  MAX_CACHED_REVIEW_DIFFS,
  MAX_CACHED_REVIEW_SOURCE_CHARACTERS,
} from "../features/review/reviewState";
import { buildCheckpointDiffTargets } from "./queryTargets";
import { lastReviewTurnDiffsAtom, recordReviewTurnDiffAnswer } from "./reviewTurnDiffs";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

// The per-turn diff sizes of a 13-turn review session measured on the desktop app.
const REVIEW_TURN_CHARACTERS = 562_571;
const REVIEW_LAST_TURN_CHARACTERS = 4_735_494;

const answer = (
  registry: AtomRegistry.AtomRegistry,
  range: { fromTurnCount: number; toTurnCount: number; diff: string },
  ignoreWhitespace = false,
) =>
  recordReviewTurnDiffAnswer(
    { environmentId, input: { ignoreWhitespace } },
    { threadId, ...range },
    registry,
  );

describe("recordReviewTurnDiffAnswer", () => {
  it.effect("keeps loaded turn diffs for review after their queries are gone", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      yield* answer(registry, { fromTurnCount: 0, toTurnCount: 1, diff: "turn one" });
      yield* answer(registry, { fromTurnCount: 1, toTurnCount: 2, diff: "turn two" });

      // A disconnected sheet mounts no turn query; every loaded turn still has its diff.
      const cached = registry.get(lastReviewTurnDiffsAtom(environmentId, threadId));
      expect(
        reviewTurnDiffsBySectionId(
          [{ checkpointTurnCount: 1 }, { checkpointTurnCount: 2 }, { checkpointTurnCount: 3 }],
          cached,
        ),
      ).toEqual({ "turn:1": "turn one", "turn:2": "turn two", "turn:3": undefined });
      registry.dispose();
    }),
  );

  it.effect("ignores ranges and whitespace-ignoring reads, which no review section shows", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      yield* answer(registry, { fromTurnCount: 0, toTurnCount: 3, diff: "whole thread" });
      yield* answer(registry, { fromTurnCount: 1, toTurnCount: 2, diff: "no whitespace" }, true);

      expect(registry.get(lastReviewTurnDiffsAtom(environmentId, threadId))).toEqual({});
      registry.dispose();
    }),
  );

  it.effect("keeps the review's own turn diffs within the budget", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const turns = 13;
      for (let turn = 1; turn <= turns; turn += 1) {
        // A review section asks for the turn before the one it shows; the first turn
        // has no earlier checkpoint and reads the thread up to it instead.
        const requested = buildCheckpointDiffTargets({
          environmentId,
          threadId,
          fromTurnCount: Math.max(0, turn - 1),
          toTurnCount: turn,
          ignoreWhitespace: false,
        });
        const target = requested.fullThread ?? requested.turn;
        if (target === null) throw new Error("A review section reads one turn.");
        yield* recordReviewTurnDiffAnswer(
          { environmentId, input: target.input },
          {
            threadId,
            fromTurnCount: requested.fullThread === null ? turn - 1 : 0,
            toTurnCount: turn,
            diff:
              turn === turns
                ? "l".repeat(REVIEW_LAST_TURN_CHARACTERS)
                : "a".repeat(REVIEW_TURN_CHARACTERS),
          },
          registry,
        );
      }

      const cached = registry.get(lastReviewTurnDiffsAtom(environmentId, threadId));
      const characters = Object.values(cached).reduce((total, diff) => total + diff.length, 0);
      expect(Object.keys(cached).length).toBeLessThanOrEqual(MAX_CACHED_REVIEW_DIFFS);
      expect(characters).toBeLessThanOrEqual(MAX_CACHED_REVIEW_SOURCE_CHARACTERS);
      // The turn whose diff is larger than the whole budget is left out, and the
      // turns around it stay.
      expect(cached[turns]).toBeUndefined();
      expect(cached[turns - 1]).toBeDefined();
      registry.dispose();
    }),
  );

  it.effect("does not grow with the number of turns in the session", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const turns = 60;
      for (let turn = 1; turn <= turns; turn += 1) {
        yield* answer(registry, {
          fromTurnCount: turn - 1,
          toTurnCount: turn,
          diff: "a".repeat(REVIEW_TURN_CHARACTERS),
        });
      }

      const cached = registry.get(lastReviewTurnDiffsAtom(environmentId, threadId));
      const characters = Object.values(cached).reduce((total, diff) => total + diff.length, 0);
      // Without the budget the session keeps every turn's diff: 60 turns of this size
      // are 33,754,260 characters of raw diff text, and each further turn adds more.
      expect(Object.keys(cached).length).toBeLessThanOrEqual(MAX_CACHED_REVIEW_DIFFS);
      expect(characters).toBeLessThanOrEqual(MAX_CACHED_REVIEW_SOURCE_CHARACTERS);
      registry.dispose();
    }),
  );

  it.effect("keeps the other turns when one diff is larger than the whole budget", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      yield* answer(registry, { fromTurnCount: 0, toTurnCount: 1, diff: "first turn" });
      yield* answer(registry, {
        fromTurnCount: 1,
        toTurnCount: 2,
        diff: "b".repeat(MAX_CACHED_REVIEW_SOURCE_CHARACTERS + 1),
      });

      const cached = registry.get(lastReviewTurnDiffsAtom(environmentId, threadId));
      expect(cached[1]).toBe("first turn");
      expect(cached[2]).toBeUndefined();
      registry.dispose();
    }),
  );

  it.effect("keeps only the newest turn diffs, so a long thread cannot grow the cache", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const turns = MAX_CACHED_REVIEW_DIFFS + 1;
      for (let turn = 1; turn <= turns; turn += 1) {
        yield* answer(registry, {
          fromTurnCount: turn - 1,
          toTurnCount: turn,
          diff: `turn ${turn}`,
        });
      }

      const cached = registry.get(lastReviewTurnDiffsAtom(environmentId, threadId));
      expect(Object.keys(cached)).toHaveLength(MAX_CACHED_REVIEW_DIFFS);
      expect(cached[1]).toBeUndefined();
      expect(cached[turns]).toBe(`turn ${turns}`);
      registry.dispose();
    }),
  );

  it.effect("drops the oldest turn diff when they exceed the character budget", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const half = Math.floor(MAX_CACHED_REVIEW_SOURCE_CHARACTERS / 2) + 1;
      const oldest = "a".repeat(half);
      const newest = "b".repeat(half);
      yield* answer(registry, { fromTurnCount: 0, toTurnCount: 1, diff: oldest });
      yield* answer(registry, { fromTurnCount: 1, toTurnCount: 2, diff: newest });

      const cached = registry.get(lastReviewTurnDiffsAtom(environmentId, threadId));
      expect(cached[1]).toBeUndefined();
      expect(cached[2]?.length).toBe(half);
      registry.dispose();
    }),
  );
});
