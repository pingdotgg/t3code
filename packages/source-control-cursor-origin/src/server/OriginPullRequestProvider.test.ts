import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OriginCli } from "./OriginCli.ts";
import { make } from "./OriginPullRequestProvider.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

const responseFor = (path: string, comments: ReadonlyArray<unknown>) => {
  if (path.includes("/comments")) return { comments };
  if (path.includes("/reviews")) return { reviews: [] };
  if (path.includes("/commits")) return { commits: [] };
  return {
    number: 1,
    title: "Fixture",
    webUrl: "https://cursor.com/codebase/acme/repo/pull/1",
    head: { ref: "feature", sha: "a".repeat(40) },
    base: { ref: "main", sha: "b".repeat(40) },
  };
};

const fakeCli = (comments: ReadonlyArray<unknown>) =>
  OriginCli.of({
    api: (input, schema) =>
      Schema.decodeEffect(schema)(responseFor(input.path, comments)).pipe(Effect.orDie),
    execute: () => Effect.succeed("{}"),
    viewer: () => Effect.succeed("viewer"),
    personalNamespace: () => Effect.succeed("viewer"),
    resolveRepository: () => Effect.succeed("acme/repo"),
  });

describe("getChangeRequestActivity", () => {
  it.effect("anchors review threads to Origin's line range", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const activity = yield* provider.getChangeRequestActivity({
        cwd: "/repo",
        repository: "acme/repo",
        host: "origin.cursor.com",
        number: 1,
      });
      const lines = Object.fromEntries(
        activity.reviewThreads.map((reviewThread) => [reviewThread.id, reviewThread.line]),
      );
      // Origin sends endLine 0 for a single-line thread.
      assert.deepStrictEqual(lines, { single: 12, range: 14 });
    }).pipe(
      Effect.provideService(
        OriginCli,
        fakeCli([
          {
            id: "comment-single",
            thread: { id: "single", path: "file.ts", side: "right", startLine: 12, endLine: 0 },
            body: "single",
            createdAt,
          },
          {
            id: "comment-range",
            thread: { id: "range", path: "file.ts", side: "right", startLine: 12, endLine: 14 },
            body: "range",
            createdAt,
          },
        ]),
      ),
      Effect.scoped,
    ),
  );
});
