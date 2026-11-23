import * as NodeHttp from "node:http";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeMarginStatsService } from "./MarginStatsService.ts";

const SAMPLE_STATS = {
  since: "today",
  savings: { tokens_est: 1200, cost_usd_est: 0.42, pct_est: 25.5 },
  totals: {
    requests: 10,
    tokens: { input: 100, output: 200, cache_read: 5000, cache_creation: 300 },
    cost_usd: 1.23,
    cost_unknown: 0,
    tier2_blocks_skipped: 4,
    tier2_chars_before: 10000,
    tier2_chars_reduced: 2500,
    tier2c_chars_reduced: 0,
    checkpoint_chars_reduced: 1500,
    pruning_chars_reduced: 0,
    secrets_redacted: 2,
  },
  by_model: [
    {
      model: "claude-sonnet-5-5",
      requests: 10,
      input_tokens: 100,
      output_tokens: 200,
      cache_read_tokens: 5000,
      cache_creation_tokens: 300,
      cost_usd: 1.23,
    },
  ],
  cache_breaks: {
    ttl_expiry: { count: 1, tokens_lost: 4000 },
  },
};

function startTestServer(handler: NodeHttp.RequestListener) {
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ url: string; server: NodeHttp.Server }>((resolve) => {
          const server = NodeHttp.createServer(handler);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address && typeof address === "object") {
              resolve({ url: `http://127.0.0.1:${address.port}`, server });
            }
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
  );
}

describe("MarginStatsService", () => {
  it.effect("returns unconfigured when ANTHROPIC_BASE_URL is unset or first-party", () =>
    Effect.gen(function* () {
      const unset = makeMarginStatsService({ getBaseUrl: () => undefined });
      assert.deepStrictEqual(yield* unset.readStats({}), { status: "unconfigured" });

      const firstParty = makeMarginStatsService({ getBaseUrl: () => "https://api.anthropic.com" });
      assert.deepStrictEqual(yield* firstParty.readStats({}), { status: "unconfigured" });
    }),
  );

  it.effect("reads /stats from a running margin proxy with optional since parameter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let seenUrl: string | undefined;
        const { url } = yield* startTestServer((req, res) => {
          seenUrl = req.url;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(SAMPLE_STATS));
        });

        const service = makeMarginStatsService({ getBaseUrl: () => url });
        const result = yield* service.readStats({ since: "today" });

        assert.strictEqual(seenUrl, "/stats?since=today");
        assert.deepStrictEqual(result, {
          status: "ready",
          endpoint: url,
          stats: SAMPLE_STATS,
        });
      }),
    ),
  );

  it.effect("returns unconfigured when endpoint returns 404 (non-margin proxy)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* startTestServer((_req, res) => {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        });

        const service = makeMarginStatsService({ getBaseUrl: () => url });
        const result = yield* service.readStats({});
        assert.deepStrictEqual(result, { status: "unconfigured" });
      }),
    ),
  );

  it.effect("returns unavailable when margin endpoint is unreachable", () =>
    Effect.gen(function* () {
      const service = makeMarginStatsService({ getBaseUrl: () => "http://127.0.0.1:1" });
      const result = yield* service.readStats({});
      assert.strictEqual(result.status, "unavailable");
    }),
  );
});
