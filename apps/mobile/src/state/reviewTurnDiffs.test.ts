import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { buildReviewParsedDiff, reviewTurnDiffsBySectionId } from "../features/review/reviewModel";
import {
  lastReviewTurnDiffsAtom,
  recordReviewTurnDiffAnswer,
  reviewTurnDiffText,
} from "./reviewTurnDiffs";

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
});
