import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";

const pullRequestRow = (id: number, state = "OPEN", headSha = `sha${id}`, baseBranch = "main") => ({
  id,
  title: `Pull request ${id}`,
  state,
  created_on: "2026-10-11T00:00:00.000000+00:00",
  updated_on: "2026-10-11T00:00:00.000000+00:00",
  source: { branch: { name: `feat/${id}` }, commit: { hash: headSha } },
  destination: { branch: { name: baseBranch } },
  links: { html: { href: `https://bitbucket.org/acme/web/pull-requests/${id}` } },
});

const listInput = {
  cwd: "/w",
  repository: "acme/web",
  host: "bitbucket.org",
  state: "all",
  involvement: "all",
  viewer: "bilal",
  limit: 10,
} as const;

it.effect("pages through rows that share an update instant by excluding those already sent", () =>
  Effect.gen(function* () {
    // Bitbucket stamps to the microsecond; 3 shares 1 and 2's millisecond but sorts after them.
    const boundary = "2026-10-12T00:00:00.000500+00:00";
    const sameMillisecond = "2026-10-12T00:00:00.000200+00:00";
    const older = "2026-10-11T00:00:00.000000+00:00";
    const micros = (stamp: string) =>
      Date.parse(stamp) * 1000 + Number(/\.\d{3}(\d{3})/.exec(stamp)?.[1] ?? 0);
    const rows = [1, 2, 3, 4, 5].map((id) => ({
      id,
      title: `Pull request ${id}`,
      state: "OPEN",
      created_on: older,
      updated_on: id <= 2 ? boundary : id === 3 ? sameMillisecond : older,
      source: { branch: { name: `feat/${id}` } },
      destination: { branch: { name: "main" } },
      links: { html: { href: `https://bitbucket.org/acme/web/pull-requests/${id}` } },
    }));
    const filters: string[] = [];
    const provider = yield* BitbucketPullRequestProvider.make.pipe(
      Effect.provide(
        BitbucketPullRequestApi.layer.pipe(
          Layer.provide(
            Layer.mock(BitbucketApi.BitbucketApi)({
              request: ({ url }) => {
                if (url.includes("/conflicts")) {
                  return Effect.succeed({ body: JSON.stringify({ values: [] }), truncated: false });
                }
                const filter =
                  new URL(url, "https://api.bitbucket.org").searchParams.get("q") ?? "";
                filters.push(filter);
                const [, operator, bound] = /updated_on (<=?) (\S+)/.exec(filter) ?? [];
                const excluded = new Set(
                  Array.from(filter.matchAll(/id != (\d+)/g), (match) => Number(match[1])),
                );
                const values = rows.filter(
                  (row) =>
                    (bound === undefined ||
                      (operator === "<"
                        ? micros(row.updated_on) < micros(bound)
                        : micros(row.updated_on) <= micros(bound))) &&
                    !excluded.has(row.id),
                );
                return Effect.succeed({ body: JSON.stringify({ values }), truncated: false });
              },
            }),
          ),
        ),
      ),
    );
    const list = (cursor?: {
      readonly updatedBefore: string;
      readonly delivered: number;
      readonly seenAt: ReadonlyArray<number>;
    }) =>
      provider.listChangeRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "bitbucket.org",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });

    const first = yield* list();
    assert.deepStrictEqual(
      first.items.map((item) => item.number),
      [1, 2],
    );
    assert.isTrue(first.truncated);

    // The cursor carries the instant cut to the millisecond, as the app normalizes it.
    const second = yield* list({
      updatedBefore: "2026-10-12T00:00:00.000Z",
      delivered: 2,
      seenAt: [1, 2],
    });
    assert.deepStrictEqual(
      second.items.map((item) => item.number),
      [3, 4],
    );
    assert.include(filters.at(-1), "updated_on < 2026-10-12T00:00:00.001Z");
    assert.include(filters.at(-1), "id != 1");
    assert.include(filters.at(-1), "id != 2");

    const last = yield* list({
      updatedBefore: "2026-10-11T00:00:00.000Z",
      delivered: 4,
      seenAt: [4],
    });
    assert.deepStrictEqual(
      last.items.map((item) => item.number),
      [5],
    );
    assert.isFalse(last.truncated);
  }),
);

it.effect("reads each open row's merge state, which a listing does not carry", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    let headSha = "sha1";
    let baseBranch = "main";
    const provider = yield* BitbucketPullRequestProvider.make.pipe(
      Effect.provide(
        BitbucketPullRequestApi.layer.pipe(
          Layer.provide(
            Layer.mock(BitbucketApi.BitbucketApi)({
              request: ({ url }) => {
                urls.push(url);
                const conflicts = /pullrequests\/(\d+)\/conflicts/.exec(url);
                if (conflicts === null) {
                  return Effect.succeed({
                    body: JSON.stringify({
                      values: [
                        pullRequestRow(1, "OPEN", headSha, baseBranch),
                        pullRequestRow(2),
                        pullRequestRow(3),
                        pullRequestRow(4, "MERGED"),
                        pullRequestRow(5, "DECLINED"),
                      ],
                    }),
                    truncated: false,
                  });
                }
                if (conflicts[1] === "3") {
                  return Effect.fail(
                    new BitbucketApi.BitbucketResponseError({
                      operation: "request",
                      status: 500,
                      responseBodyLength: 0,
                    }),
                  );
                }
                return Effect.succeed({
                  body: JSON.stringify({
                    values: conflicts[1] === "1" && headSha === "sha1" ? [{ path: "a.ts" }] : [],
                  }),
                  truncated: false,
                });
              },
            }),
          ),
        ),
      ),
    );
    const list = (repository: string = listInput.repository) =>
      provider.listChangeRequests({ ...listInput, repository });
    const conflictNumbers = () =>
      urls
        .filter((url) => url.includes("/conflicts"))
        .map((url) => /pullrequests\/(\d+)/.exec(url)?.[1]);

    const first = yield* list();

    assert.deepStrictEqual(
      first.items.map((item) => item.mergeability),
      ["conflicting", "mergeable", "unknown", "unknown", "unknown"],
    );
    assert.deepStrictEqual(conflictNumbers(), ["1", "2", "3"]);

    // A second listing reuses the answers it already has; only the failed read is retried.
    urls.length = 0;
    yield* list();
    assert.deepStrictEqual(conflictNumbers(), ["3"]);

    headSha = "new-head";
    urls.length = 0;
    const pushed = yield* list();
    assert.strictEqual(pushed.items[0]?.mergeability, "mergeable");
    assert.deepStrictEqual(conflictNumbers(), ["1", "3"]);

    // Retargeting keeps the head but changes what it merges into.
    baseBranch = "release";
    urls.length = 0;
    yield* list();
    assert.deepStrictEqual(conflictNumbers(), ["1", "3"]);

    urls.length = 0;
    yield* list("acme/other");
    assert.deepStrictEqual(conflictNumbers(), ["1", "2", "3"]);
    assert.isTrue(urls.every((url) => url.startsWith("/repositories/acme/other/")));

    yield* TestClock.adjust("599 seconds");
    urls.length = 0;
    yield* list();
    assert.deepStrictEqual(conflictNumbers(), ["3"]);

    yield* TestClock.adjust("1 second");
    urls.length = 0;
    yield* list();
    assert.deepStrictEqual(conflictNumbers(), ["1", "2", "3"]);
  }),
);

it.effect("bounds conflict reads to five and shares pending lookups across lists", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const fiveStarted = yield* Deferred.make<void>();
    const bothListed = yield* Deferred.make<void>();
    let active = 0;
    let maximum = 0;
    let conflictReads = 0;
    let listings = 0;
    const provider = yield* BitbucketPullRequestProvider.make.pipe(
      Effect.provide(
        BitbucketPullRequestApi.layer.pipe(
          Layer.provide(
            Layer.mock(BitbucketApi.BitbucketApi)({
              request: ({ url }) =>
                Effect.gen(function* () {
                  if (!url.includes("/conflicts")) {
                    listings++;
                    if (listings === 2) yield* Deferred.succeed(bothListed, undefined);
                    return {
                      body: JSON.stringify({
                        values: Array.from({ length: 7 }, (_, index) => pullRequestRow(index + 1)),
                      }),
                      truncated: false,
                    };
                  }
                  active++;
                  conflictReads++;
                  maximum = Math.max(maximum, active);
                  if (active === 5) yield* Deferred.succeed(fiveStarted, undefined);
                  yield* Deferred.await(release);
                  active--;
                  return { body: JSON.stringify({ values: [] }), truncated: false };
                }),
            }),
          ),
        ),
      ),
    );
    const lists = yield* Effect.all(
      [provider.listChangeRequests(listInput), provider.listChangeRequests(listInput)],
      { concurrency: 2 },
    ).pipe(Effect.forkChild);
    yield* Deferred.await(bothListed);
    yield* Deferred.await(fiveStarted);
    yield* Deferred.succeed(release, undefined);
    const batches = yield* Fiber.join(lists);
    assert.strictEqual(maximum, 5);
    assert.strictEqual(conflictReads, 7);
    for (const batch of batches) {
      assert.deepStrictEqual(
        batch.items.map((item) => item.number),
        [1, 2, 3, 4, 5, 6, 7],
      );
      assert.isTrue(batch.items.every((item) => item.mergeability === "mergeable"));
    }
  }),
);

it.effect.each(["response", "body read", "paused"] as const)(
  "preserves %s rate limits from a listing's conflict reads",
  (variant) =>
    Effect.gen(function* () {
      const error =
        variant === "response"
          ? new BitbucketApi.BitbucketResponseError({
              operation: "request",
              status: 429,
              responseBodyLength: 0,
              retryAt: 120_000,
            })
          : variant === "body read"
            ? new BitbucketApi.BitbucketResponseBodyReadError({
                operation: "request",
                status: 429,
                cause: new Error("stream failed"),
                retryAt: 120_000,
              })
            : new SourceControlRateLimit.SourceControlRateLimitPausedError({
                provider: SourceControlProviderKind.make("bitbucket"),
                host: "bitbucket.org",
                retryAt: 120_000,
              });
      let limited = true;
      const provider = yield* BitbucketPullRequestProvider.make.pipe(
        Effect.provide(
          BitbucketPullRequestApi.layer.pipe(
            Layer.provide(
              Layer.mock(BitbucketApi.BitbucketApi)({
                request: ({ url }) =>
                  url.includes("/conflicts")
                    ? limited
                      ? Effect.fail(error)
                      : Effect.succeed({ body: JSON.stringify({ values: [] }), truncated: false })
                    : Effect.succeed({
                        body: JSON.stringify({ values: [pullRequestRow(1)] }),
                        truncated: false,
                      }),
              }),
            ),
          ),
        ),
      );
      const failure = yield* Effect.flip(provider.listChangeRequests(listInput));
      assert.strictEqual(failure.reason, "rate-limited");
      assert.strictEqual(failure.retryAt, 120_000);
      assert.strictEqual(failure.operation, "listChangeRequests");
      assert.strictEqual(failure.cause, error);
      limited = false;
      const recovered = yield* provider.listChangeRequests(listInput);
      assert.strictEqual(recovered.items[0]?.mergeability, "mergeable");
    }),
);
