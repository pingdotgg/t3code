import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { reviewTurnDiffsBySectionId } from "../features/review/reviewModel";
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
});
