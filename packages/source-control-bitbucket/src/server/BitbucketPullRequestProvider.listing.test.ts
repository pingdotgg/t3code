import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { PullRequestListFilters } from "@t3tools/contracts";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";

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
                const statuses = /pullrequests\/(\d+)\/statuses/.exec(url);
                if (statuses !== null) {
                  return Effect.succeed({
                    body: JSON.stringify({
                      values: [
                        {
                          key: "ci",
                          state: Number(statuses[1]) % 2 === 1 ? "FAILED" : "SUCCESSFUL",
                        },
                      ],
                    }),
                    truncated: false,
                  });
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
        filters: { checks: "failing" },
        ...(cursor === undefined ? {} : { cursor }),
      });

    const first = yield* list();
    assert.deepStrictEqual(
      first.items.map((item) => item.number),
      [1, 2],
    );
    assert.isTrue(first.truncated);
    assert.deepStrictEqual(
      first.items.map((item) => item.checksState),
      ["failing", "passing"],
    );

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

it.effect("reads check results per row only when the listing filters on checks", () =>
  Effect.gen(function* () {
    let headSha = "head-1";
    const row = (id: number) => ({
      id,
      title: `Pull request ${id}`,
      state: "OPEN",
      created_on: "2026-10-11T00:00:00.000000+00:00",
      updated_on: "2026-10-11T00:00:00.000000+00:00",
      source: { branch: { name: `feat/${id}` }, commit: { hash: headSha } },
      draft: id === 3,
      reviewers: id === 4 ? [{ nickname: "reviewer" }] : [],
      destination: { branch: { name: "main" } },
      links: { html: { href: `https://bitbucket.org/acme/web/pull-requests/${id}` } },
    });
    const urls: string[] = [];
    const provider = yield* BitbucketPullRequestProvider.make.pipe(
      Effect.provide(
        BitbucketPullRequestApi.layer.pipe(
          Layer.provide(
            Layer.mock(BitbucketApi.BitbucketApi)({
              request: ({ url }) => {
                urls.push(url);
                const statuses = /pullrequests\/(\d+)\/statuses/.exec(url);
                const values =
                  statuses === null
                    ? [row(1), row(2), row(3), row(4)]
                    : [
                        {
                          key: "ci",
                          name: "ci",
                          state: statuses[1] === "1" ? "FAILED" : "SUCCESSFUL",
                        },
                      ];
                return Effect.succeed({ body: JSON.stringify({ values }), truncated: false });
              },
            }),
          ),
        ),
      ),
    );
    const list = (filters?: PullRequestListFilters, repository = "acme/web") =>
      provider.listChangeRequests({
        cwd: "/w",
        repository,
        host: "bitbucket.org",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters,
      });

    const unfiltered = yield* list();
    assert.isFalse(urls.some((url) => url.includes("/statuses")));
    assert.deepStrictEqual(
      unfiltered.items.map((item) => item.checksState),
      [undefined, undefined, undefined, undefined],
    );

    const filters = { checks: "failing", review: "none", draft: "hide" } as const;
    const filtered = yield* list(filters);
    assert.deepStrictEqual(
      filtered.items.map((item) => item.checksState),
      ["failing", "passing", undefined, undefined],
    );
    assert.deepStrictEqual(
      filtered.items.map((item) => item.number),
      [1, 2, 3, 4],
    );
    const statusReads = () => urls.filter((url) => url.includes("/statuses")).length;
    assert.strictEqual(statusReads(), 2);
    yield* list(filters);
    assert.strictEqual(statusReads(), 2);
    headSha = "head-2";
    yield* list(filters);
    assert.strictEqual(statusReads(), 4);
    yield* list(filters, "acme/other");
    assert.strictEqual(statusReads(), 6);
    yield* TestClock.adjust("2 minutes");
    yield* list(filters);
    assert.strictEqual(statusReads(), 8);
  }),
);

it.effect.each([401, 403, 404, 429, 500])(
  "reports HTTP %s status failures instead of caching them as no checks",
  (status) =>
    Effect.gen(function* () {
      let failing = true;
      const error = new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status,
        responseBodyLength: 0,
        retryAt: 120_000,
      });
      const provider = yield* BitbucketPullRequestProvider.make.pipe(
        Effect.provide(
          BitbucketPullRequestApi.layer.pipe(
            Layer.provide(
              Layer.mock(BitbucketApi.BitbucketApi)({
                request: ({ url }) => {
                  if (url.includes("/statuses")) {
                    return failing
                      ? Effect.fail(error)
                      : Effect.succeed({
                          body: JSON.stringify({ values: [{ key: "ci", state: "SUCCESSFUL" }] }),
                          truncated: false,
                        });
                  }
                  return Effect.succeed({
                    body: JSON.stringify({
                      values: [
                        {
                          id: 1,
                          title: "PR",
                          state: "OPEN",
                          created_on: "2026-10-11T00:00:00Z",
                          updated_on: "2026-10-11T00:00:00Z",
                          source: { branch: { name: "feature" } },
                          destination: { branch: { name: "main" } },
                          links: {
                            html: { href: "https://bitbucket.org/acme/web/pull-requests/1" },
                          },
                        },
                      ],
                    }),
                    truncated: false,
                  });
                },
              }),
            ),
          ),
        ),
      );
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "bitbucket.org",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { checks: "passing" },
      } as const;
      const result = yield* Effect.result(provider.listChangeRequests(input));
      assert.deepStrictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(
          result.failure.reason,
          status === 401
            ? "unauthenticated"
            : status === 404
              ? "not-found"
              : status === 429
                ? "rate-limited"
                : "failed",
        );
        if (status === 429) assert.strictEqual(result.failure.retryAt, 120_000);
      }
      failing = false;
      assert.strictEqual(
        (yield* provider.listChangeRequests(input)).items[0]?.checksState,
        "passing",
      );
    }),
);

it.effect("reads checks only for rows by the filtered author", () =>
  Effect.gen(function* () {
    const row = (id: number, nickname: string) => ({
      id,
      title: `Pull request ${id}`,
      state: "OPEN",
      created_on: "2026-10-11T00:00:00Z",
      updated_on: "2026-10-11T00:00:00Z",
      author: { nickname },
      source: { branch: { name: `feat/${id}` } },
      destination: { branch: { name: "main" } },
      links: { html: { href: `https://bitbucket.org/acme/web/pull-requests/${id}` } },
    });
    const urls: string[] = [];
    const provider = yield* BitbucketPullRequestProvider.make.pipe(
      Effect.provide(
        BitbucketPullRequestApi.layer.pipe(
          Layer.provide(
            Layer.mock(BitbucketApi.BitbucketApi)({
              request: ({ url }) => {
                urls.push(url);
                const values = url.includes("/statuses")
                  ? [{ key: "ci", state: "SUCCESSFUL" }]
                  : [row(1, "Ana"), row(2, "bilal")];
                return Effect.succeed({ body: JSON.stringify({ values }), truncated: false });
              },
            }),
          ),
        ),
      ),
    );

    const listed = yield* provider.listChangeRequests({
      cwd: "/w",
      repository: "acme/web",
      host: "bitbucket.org",
      state: "open",
      involvement: "all",
      viewer: "bilal",
      limit: 10,
      filters: { author: "ana", checks: "passing" },
    });

    assert.deepStrictEqual(
      listed.items.map((item) => item.checksState),
      ["passing", undefined],
    );
    assert.deepStrictEqual(
      urls
        .filter((url) => url.includes("/statuses"))
        .map((url) => /pullrequests\/(\d+)/.exec(url)?.[1]),
      ["1"],
    );
  }),
);
