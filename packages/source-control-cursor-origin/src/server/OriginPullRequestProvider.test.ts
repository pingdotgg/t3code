import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import { OriginCli } from "./OriginCli.ts";
import { make } from "./OriginPullRequestProvider.ts";

const head = "a".repeat(40);
const baseB = "b".repeat(40);
const baseC = "c".repeat(40);
const preparedBase = "d".repeat(40);

describe("OriginPullRequestProvider.getChangeRequest", () => {
  it.effect("does not keep a verdict Origin gave for a base other than the tip read", () =>
    Effect.gen(function* () {
      const verdicts = [
        { verdict: "blocked", baseSha: baseC, blockers: [{ kind: "merge_conflict" }] },
        { verdict: "mergeable", baseSha: baseB, blockers: [] },
      ];
      let mergeabilityReads = 0;
      const cli = OriginCli.of({
        api: (input, schema) =>
          Effect.suspend(() => {
            const data: unknown =
              input.operation === "getPullRequest"
                ? {
                    number: 1,
                    state: "open",
                    title: "Fixture",
                    webUrl: "https://cursor.com/codebase/fixture/repo/pull/1",
                    head: { ref: "feature", sha: head },
                    base: { ref: "main", sha: preparedBase },
                    version: {
                      headSha: head,
                      baseSha: preparedBase,
                      potentialMergeCommit: { state: "prepared", baseSha: preparedBase },
                    },
                  }
                : input.operation === "getRepository"
                  ? { name: "repo" }
                  : input.operation === "listChecks"
                    ? { checkRuns: [] }
                    : input.operation === "getBaseTip"
                      ? { object: { sha: baseB } }
                      : input.operation === "getMergeability"
                        ? { headSha: head, baseRef: "main", ...verdicts[mergeabilityReads++] }
                        : undefined;
            return data === undefined
              ? Effect.die(new Error(`unexpected operation ${input.operation}`))
              : Schema.decodeEffect(schema)(data).pipe(Effect.orDie);
          }),
        execute: () => Effect.succeed("{}"),
        viewer: () => Effect.succeed("fixture"),
        personalNamespace: () => Effect.succeed("fixture"),
        resolveRepository: () => Effect.succeed("fixture/repo"),
      });

      const provider = yield* make.pipe(Effect.provideService(OriginCli, cli));
      const input = { cwd: "/fixture", host: "cursor.com", repository: "fixture/repo", number: 1 };
      // Origin evaluated the head against C, a base pushed after the tip B was read.
      yield* provider.getChangeRequest(input);
      // Past every short-lived read cache; the base's tip is B again.
      yield* TestClock.adjust("3 seconds");
      const detail = yield* provider.getChangeRequest(input);

      assert.strictEqual(detail.mergeability, "mergeable");
    }),
  );
});
