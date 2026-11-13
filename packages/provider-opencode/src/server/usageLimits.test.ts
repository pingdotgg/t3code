import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { makeUsageHttpClient } from "@t3tools/provider-core/server/usageLimits";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, HttpClientError } from "effect/http";
import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";

it.effect.each([200, 503, "transport"] as const)(
  "preserves the original Go cache deadline for another instance (HTTP %s)",
  (status) =>
    Effect.gen(function* () {
      let reads = 0;
      const client = yield* makeUsageHttpClient(
        HttpClient.make((request) =>
          Effect.gen(function* () {
            reads++;
            if (status === "transport")
              return yield* new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "offline" }),
              });
            const window = { percent: 10, resetsAt: "2026-11-01T00:00:00Z" };
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                { usage: { rolling: window, weekly: window, monthly: window } },
                { status },
              ),
            );
          }),
        ),
      );
      const probe = readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          XDG_DATA_HOME: "/unused",
          OPENCODE_AUTH_CONTENT: JSON.stringify({
            "opencode-go": { type: "api", key: "shared-key" },
          }),
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      const first = yield* probe;
      yield* TestClock.adjust("4 minutes");
      const cached = yield* probe;
      assert.strictEqual(reads, 1);
      if (status === 200) assert.strictEqual(cached.checkedAt, first.checkedAt);
      assert.strictEqual(cached.refreshAfter, 300_000);
      yield* TestClock.adjust("1 minute");
      const fresh = yield* probe;
      assert.strictEqual(reads, 2);
      assert.strictEqual(fresh.refreshAfter, 600_000);
    }).pipe(Effect.provide([NodeServices.layer, NodeCrypto.layer])),
);
