import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
