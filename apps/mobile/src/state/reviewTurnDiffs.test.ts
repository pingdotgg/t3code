import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { buildReviewParsedDiff, reviewTurnDiffsBySectionId } from "../features/review/reviewModel";
import {
  MAX_CACHED_REVIEW_DIFFS,
  MAX_CACHED_REVIEW_SOURCE_CHARACTERS,
} from "../features/review/reviewState";
import { buildCheckpointDiffTargets } from "./queryTargets";
import {
  lastReviewTurnDiffsAtom,
  recordReviewTurnDiffAnswer,
  reviewTurnDiffText,
} from "./reviewTurnDiffs";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

// The per-turn diff sizes of a 13-turn review session measured on the desktop app.
const REVIEW_TURN_CHARACTERS = 562_571;
const REVIEW_LAST_TURN_CHARACTERS = 4_735_494;
// How many of those turns fit the byte budget. The turn whose diff is larger than the
// whole budget is left out, so the kept turns are the newest ones that fit.
const KEPT_REVIEW_TURNS = Math.floor(MAX_CACHED_REVIEW_SOURCE_CHARACTERS / REVIEW_TURN_CHARACTERS);
const newestTurns = (newest: number, count: number) =>
  Array.from({ length: count }, (_, index) => newest - count + 1 + index);

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

const modified = (path: string, line: string) =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1,2 @@",
    " const before = 1;",
    `+${line}`,
    "",
  ].join("\n");

describe("reviewTurnDiffText", () => {
  it("leaves a thread without repositories its one patch", () => {
    const diff = modified("src/index.ts", "const root = 1;");
    expect(reviewTurnDiffText({ diff })).toBe(diff);
    expect(reviewTurnDiffText({ diff, repositories: [] })).toBe(diff);
  });

  it("names each repository's files from the thread's folder", () => {
    const text = reviewTurnDiffText({
      diff: "",
      repositories: [
        {
          name: "api",
          repositoryPath: "/work/api",
          relativePath: "api",
          diff: [
            modified("src/index.ts", "--- a/not-a-header"),
            "diff --git a/added.ts b/added.ts",
            "new file mode 100644",
            "index 0000000..2222222",
            "--- /dev/null",
            "+++ b/added.ts",
            "@@ -0,0 +1 @@",
            "+export {};",
            "diff --git a/old name.ts b/new name.ts",
            "similarity index 100%",
            "rename from old name.ts",
            "rename to new name.ts",
            "",
          ].join("\n"),
        },
        {
          name: "web",
          repositoryPath: "/elsewhere/web",
          relativePath: "../elsewhere/web",
          diff: `${modified("src/index.ts", "const web = 1;")}\n[truncated]`,
        },
      ],
    });

    expect(text).toContain("+--- a/not-a-header\n");
    expect(text).toContain("rename from api/old name.ts\nrename to api/new name.ts\n");
    expect(text.endsWith("\n\n[truncated]")).toBe(true);
    const complete = buildReviewParsedDiff(text.replace("[truncated]", ""), "unit-repositories");
    expect(complete.kind === "files" && complete.files.map((file) => file.path)).toEqual([
      "api/src/index.ts",
      "api/added.ts",
      "api/new name.ts",
      "../elsewhere/web/src/index.ts",
    ]);
    expect(
      complete.kind === "files" && complete.files[1]?.completePatchSource?.().newContents,
    ).toBe("export {};\n");
    expect(buildReviewParsedDiff(text, "unit-repositories-truncated")).toMatchObject({
      kind: "files",
      fileCount: 4,
      notice: expect.stringContaining("server size cap"),
    });
  });
});

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
      // The kept set is the newest turns that fit, so an implementation that keeps
      // every turn fails here with the map it retained.
      expect({ turns: Object.keys(cached).map(Number), characters }).toEqual({
        turns: newestTurns(turns - 1, KEPT_REVIEW_TURNS),
        characters: KEPT_REVIEW_TURNS * REVIEW_TURN_CHARACTERS,
      });
      // The turn whose diff is larger than the whole budget is left out, and the
      // turns around it stay.
      expect(cached[turns]).toBeUndefined();
      expect(cached[turns - 1]).toBeDefined();
      registry.dispose();
    }),
  );

  it.effect("keeps the same turns when the first review section read the whole thread", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const turns = 13;
      // The desktop capture's first read covered the whole thread, and the recorder
      // leaves ranges out, so only turns 2..13 are answered one turn at a time.
      yield* answer(registry, {
        fromTurnCount: 0,
        toTurnCount: turns,
        diff: "a".repeat(REVIEW_TURN_CHARACTERS),
      });
      for (let turn = 2; turn <= turns; turn += 1) {
        yield* answer(registry, {
          fromTurnCount: turn - 1,
          toTurnCount: turn,
          diff:
            turn === turns
              ? "l".repeat(REVIEW_LAST_TURN_CHARACTERS)
              : "a".repeat(REVIEW_TURN_CHARACTERS),
        });
      }

      const cached = registry.get(lastReviewTurnDiffsAtom(environmentId, threadId));
      const characters = Object.values(cached).reduce((total, diff) => total + diff.length, 0);
      expect({ turns: Object.keys(cached).map(Number), characters }).toEqual({
        turns: newestTurns(turns - 1, KEPT_REVIEW_TURNS),
        characters: KEPT_REVIEW_TURNS * REVIEW_TURN_CHARACTERS,
      });
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
