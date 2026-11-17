import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { reviewTurnDiffsBySectionId } from "../features/review/reviewModel";
import {
  MAX_CACHED_REVIEW_DIFFS,
  MAX_CACHED_REVIEW_SOURCE_CHARACTERS,
} from "../features/review/reviewState";
import { lastReviewTurnDiffsAtom, recordReviewTurnDiffAnswer } from "./reviewTurnDiffs";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

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
