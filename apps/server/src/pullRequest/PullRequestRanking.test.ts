import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as PullRequestRanking from "./PullRequestRanking.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5",
};

const numbers = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

const request = (count: number) => ({
  cwd: "/repo",
  repository: "pingdotgg/t3code",
  intoRepository: "t3code",
  candidates: numbers(count).map((number) => ({ number, title: `Change ${number}` })),
  modelSelection,
});

/**
 * A stand-in agent that records the batches it was asked about and scores each row by its own
 * number, so what came back can be traced to what went out.
 */
const makeRanking = (options: {
  readonly batches: Ref.Ref<ReadonlyArray<ReadonlyArray<number>>>;
  readonly refuseBatch?: number;
}) =>
  PullRequestRanking.make.pipe(
    Effect.provide(
      Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("not used"),
          generatePrContent: () => Effect.die("not used"),
          generateBranchName: () => Effect.die("not used"),
          generateThreadTitle: () => Effect.die("not used"),
          generateReviewGuide: () => Effect.die("not used"),
          generateTranscriptionPostProcessing: () => Effect.die("not used"),
          rankPullRequests: (input) =>
            Ref.updateAndGet(options.batches, (seen) => [
              ...seen,
              input.candidates.map((candidate) => candidate.number),
            ]).pipe(
              Effect.flatMap((seen) =>
                options.refuseBatch === seen.length
                  ? Effect.fail(
                      new TextGenerationError({
                        operation: "rankPullRequests",
                        detail: "the agent refused this batch",
                      }),
                    )
                  : Effect.succeed({
                      rankings: input.candidates.map((candidate) => ({
                        number: candidate.number,
                        score: candidate.number,
                      })),
                    }),
              ),
            ),
        }),
      ),
    ),
  );

it.effect("ranks every candidate rather than the first promptful", () =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
    const ranking = yield* makeRanking({ batches });

    // Comfortably more than one batch, so an implementation that truncated would be visible.
    const rankings = yield* ranking.rank(request(95));

    assert.strictEqual(rankings.length, 95);
    const seen = yield* Ref.get(batches);
    assert.isAbove(seen.length, 1);
    assert.deepStrictEqual(
      seen.flat().toSorted((left, right) => left - right),
      numbers(95),
    );
  }),
);

it.effect("keeps the batches an agent did answer when one of them fails", () =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
    const ranking = yield* makeRanking({ batches, refuseBatch: 1 });

    const rankings = yield* ranking.rank(request(95));

    // The refused batch costs its own rows and no more; the rest are still worth showing.
    assert.isAbove(rankings.length, 0);
    assert.isBelow(rankings.length, 95);
  }),
);

it.effect("ignores a score for a pull request nobody asked about", () =>
  Effect.gen(function* () {
    const ranking = yield* PullRequestRanking.make.pipe(
      Effect.provide(
        Layer.succeed(
          TextGeneration.TextGeneration,
          TextGeneration.TextGeneration.of({
            generateCommitMessage: () => Effect.die("not used"),
            generatePrContent: () => Effect.die("not used"),
            generateBranchName: () => Effect.die("not used"),
            generateThreadTitle: () => Effect.die("not used"),
            generateReviewGuide: () => Effect.die("not used"),
            generateTranscriptionPostProcessing: () => Effect.die("not used"),
            rankPullRequests: () =>
              Effect.succeed({
                rankings: [
                  { number: 1, score: 10 },
                  { number: 4242, score: 100 },
                ],
              }),
          }),
        ),
      ),
    );

    const rankings = yield* ranking.rank(request(2));

    assert.deepStrictEqual(
      rankings.map((entry) => entry.number),
      [1],
    );
  }),
);

it.effect("asks nothing of an agent when there is nothing to rank", () =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
    const ranking = yield* makeRanking({ batches });

    const rankings = yield* ranking.rank({ ...request(0), candidates: [] });

    assert.deepStrictEqual(rankings, []);
    assert.deepStrictEqual(yield* Ref.get(batches), []);
  }),
);

it.effect("judges a pull request once and remembers it", () =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
    const ranking = yield* makeRanking({ batches });

    const first = yield* ranking.rank(request(3));
    const second = yield* ranking.rank(request(3));

    assert.deepStrictEqual(second, first);
    // The second ask reached the agent with nothing: every row was already judged.
    assert.strictEqual((yield* Ref.get(batches)).length, 1);
  }),
);

it.effect("asks again only about the rows it has not judged", () =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
    const ranking = yield* makeRanking({ batches });

    yield* ranking.rank(request(3));
    const widened = yield* ranking.rank(request(5));

    assert.strictEqual(widened.length, 5);
    const seen = yield* Ref.get(batches);
    // The second call carried the two new pull requests and nothing else.
    assert.deepStrictEqual(seen[1], [4, 5]);
  }),
);

it.effect("judges a pull request again once its title changes", () =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
    const ranking = yield* makeRanking({ batches });

    yield* ranking.rank({ ...request(1), candidates: [{ number: 1, title: "Before" }] });
    yield* ranking.rank({ ...request(1), candidates: [{ number: 1, title: "After" }] });

    // Keyed by the title it was judged on, so an edit is not served a stale opinion.
    assert.deepStrictEqual(yield* Ref.get(batches), [[1], [1]]);
  }),
);

it.effect("judges again when the reader switches to another agent", () =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
    const ranking = yield* makeRanking({ batches });
    const other = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };

    yield* ranking.rank(request(2));
    yield* ranking.rank({ ...request(2), modelSelection: other });
    // Switching is how a reader asks for a second opinion, so it must not be served the first.
    assert.deepStrictEqual(yield* Ref.get(batches), [
      [1, 2],
      [1, 2],
    ]);

    yield* ranking.rank(request(2));
    // ...and switching back costs nothing, because each agent keeps its own answers.
    assert.strictEqual((yield* Ref.get(batches)).length, 2);
  }),
);
