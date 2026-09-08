import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, it, vi } from "vitest";
import * as RateLimit from "../../bindings/rate-limit/RateLimit.ts";
import makeBinding from "../../bindings/rate-limit/RateLimitBinding.worker.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const RATE_LIMIT_SCRIPT = `
export default {
  async fetch(request, env) {
    const { success } = await env.TESTRATE.limit({ key: "test" });
    if (!success) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response("success", { status: 200 });
  },
};
`;

const RATE_LIMIT_QUERY_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const options = { key: url.searchParams.get("key") ?? "" };
    const period = url.searchParams.get("period");
    if (period !== null) {
      options.period = Number(period);
    }
    const { success } = await env.TESTRATE.limit(options);
    if (!success) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response("success", { status: 200 });
  },
};
`;

const RATE_LIMIT_VALIDATION_SCRIPT = `
export default {
  async fetch(request, env) {
    const options = await request.json();
    try {
      await env.TESTRATE.limit(options);
    } catch (e) {
      return new Response(String(e), { status: 200 });
    }
    return new Response("should have resulted in error", { status: 500 });
  },
};
`;

layer(localRuntimeLayer)("RateLimit binding", (it) => {
  it.effect(
    "limits requests once the configured threshold is reached",
    () =>
      Effect.gen(function* () {
        const { fetch } = yield* startTestWorker({
          name: "ratelimit-test",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: RATE_LIMIT_SCRIPT },
          ],
          bindings: [
            RateLimit.local({
              binding: "TESTRATE",
              namespaceId: 1,
              simple: { limit: 2, period: 60 },
            }),
          ],
        });

        let res = yield* fetch("/");
        expect(res.status).toBe(200);
        expect(yield* Effect.promise(() => res.text())).toBe("success");

        res = yield* fetch("/");
        expect(res.status).toBe(200);
        expect(yield* Effect.promise(() => res.text())).toBe("success");

        res = yield* fetch("/");
        expect(res.status).toBe(429);
        expect(yield* Effect.promise(() => res.text())).toBe("rate limited");
      }),
    // The window is anchored at the first request per key, so three
    // sequential requests must trip deterministically — no CI retry.
    { retry: 0 },
  );

  it.effect(
    "sequential triples trip deterministically across many keys",
    () =>
      Effect.gen(function* () {
        const { fetch } = yield* startTestWorker({
          name: "ratelimit-sequential-stress",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: RATE_LIMIT_QUERY_SCRIPT,
            },
          ],
          bindings: [
            RateLimit.local({
              binding: "TESTRATE",
              namespaceId: 1,
              simple: { limit: 2, period: 60 },
            }),
          ],
        });

        for (let i = 0; i < 10; i++) {
          const statuses: Array<number> = [];
          for (let j = 0; j < 3; j++) {
            const res = yield* fetch(`/?key=seq-${i}`);
            statuses.push(res.status);
          }
          expect(statuses).toEqual([200, 200, 429]);
        }
      }),
    { retry: 0 },
  );

  it.effect(
    "parallel requests never exceed the limit and never lose an increment",
    () =>
      Effect.gen(function* () {
        const { fetch } = yield* startTestWorker({
          name: "ratelimit-parallel-stress",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: RATE_LIMIT_QUERY_SCRIPT,
            },
          ],
          bindings: [
            RateLimit.local({
              binding: "TESTRATE",
              namespaceId: 1,
              simple: { limit: 5, period: 60 },
            }),
          ],
        });

        const responses = yield* Effect.all(
          Array.from({ length: 20 }, () => fetch("/?key=parallel")),
          { concurrency: "unbounded" },
        );
        const statuses = responses.map((res) => res.status);
        expect(statuses.filter((status) => status === 200)).toHaveLength(5);
        expect(statuses.filter((status) => status === 429)).toHaveLength(15);
      }),
    { retry: 0 },
  );

  it.effect(
    "a call with a different period does not clear other keys' counters",
    () =>
      Effect.gen(function* () {
        const { fetch } = yield* startTestWorker({
          name: "ratelimit-mixed-periods",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: RATE_LIMIT_QUERY_SCRIPT,
            },
          ],
          bindings: [
            RateLimit.local({
              binding: "TESTRATE",
              namespaceId: 1,
              simple: { limit: 2, period: 60 },
            }),
          ],
        });

        expect((yield* fetch("/?key=b")).status).toBe(200);
        expect((yield* fetch("/?key=b")).status).toBe(200);
        // With the old shared wall-clock epoch, this period-10 call
        // recomputed the epoch on a different scale and cleared EVERY bucket.
        expect((yield* fetch("/?key=a&period=10")).status).toBe(200);
        expect((yield* fetch("/?key=b")).status).toBe(429);
      }),
    { retry: 0 },
  );

  it.effect("validates options passed to limit()", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "ratelimit-validation",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        modules: [
          {
            name: "main.js",
            type: "ESModule",
            content: RATE_LIMIT_VALIDATION_SCRIPT,
          },
        ],
        bindings: [
          RateLimit.local({
            binding: "TESTRATE",
            namespaceId: 1,
            simple: { limit: 2, period: 60 },
          }),
        ],
      });

      const TESTS = [
        { options: "invalid", error: "Error: invalid rate limit options" },
        {
          options: { invalid: "foo" },
          error: "Error: bad rate limit options: [invalid]",
        },
        {
          options: { limit: "bad" },
          error: "Error: limit must be a number: bad",
        },
        {
          options: { period: "bad" },
          error: "Error: period must be a number: bad",
        },
        { options: { period: 1 }, error: "Error: unsupported period: 1" },
      ];

      for (const { options, error } of TESTS) {
        const res = yield* fetch("/", {
          method: "POST",
          body: JSON.stringify(options),
        });
        expect(res.status).toBe(200);
        expect(yield* Effect.promise(() => res.text())).toBe(error);
      }
    }),
  );
});

// Unit tests against the simulator class itself, with Date.now pinned so the
// wall-clock scenarios that flaked on CI are reproduced deterministically.
describe("RateLimit counter", () => {
  const MINUTE = 60_000;
  // a wall-clock instant exactly on an absolute minute boundary
  const BOUNDARY = Math.ceil(1_754_300_000_000 / MINUTE) * MINUTE;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const make = () =>
    makeBinding({
      PROPS: {
        binding: "TESTRATE",
        namespaceId: 1,
        simple: { limit: 2, period: 60 },
      },
    });

  it("does not reset the counter when the wall clock crosses a minute boundary mid-window", async () => {
    const now = vi.spyOn(Date, "now");
    const binding = make();

    now.mockReturnValue(BOUNDARY - 500);
    expect(await binding.limit({ key: "test" })).toEqual({ success: true });
    expect(await binding.limit({ key: "test" })).toEqual({ success: true });

    // the CI flake: the old epoch (floor(now / period)) rolled over here and
    // cleared the buckets, letting the third sequential request through
    now.mockReturnValue(BOUNDARY + 500);
    expect(await binding.limit({ key: "test" })).toEqual({ success: false });
  });

  it("opens a new window once the period has elapsed since the first request", async () => {
    const now = vi.spyOn(Date, "now");
    const binding = make();

    now.mockReturnValue(BOUNDARY - 500);
    expect(await binding.limit({ key: "test" })).toEqual({ success: true });
    expect(await binding.limit({ key: "test" })).toEqual({ success: true });
    expect(await binding.limit({ key: "test" })).toEqual({ success: false });

    now.mockReturnValue(BOUNDARY - 500 + 60 * 1000);
    expect(await binding.limit({ key: "test" })).toEqual({ success: true });
  });

  it("keeps counters independent per key and period", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(BOUNDARY + 1);
    const binding = make();

    // extra props beyond `key` are accepted by the sim (limit/period overrides)
    const periodA: { key: string; period: number } = { key: "a", period: 10 };

    expect(await binding.limit({ key: "b" })).toEqual({ success: true });
    expect(await binding.limit({ key: "b" })).toEqual({ success: true });
    expect(await binding.limit(periodA)).toEqual({ success: true });
    expect(await binding.limit({ key: "b" })).toEqual({ success: false });

    // key "a" has its own 10s window, unaffected by "b" being exhausted
    now.mockReturnValue(BOUNDARY + 1 + 9_000);
    expect(await binding.limit(periodA)).toEqual({ success: true });
  });

  it("loses no increments under concurrent calls", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BOUNDARY + 1);
    const binding = make();

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, () => binding.limit({ key: "test" })),
    );
    expect(outcomes.filter((outcome) => outcome.success)).toHaveLength(2);
  });
});
