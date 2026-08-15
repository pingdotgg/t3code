// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

/**
 * Two tiny documents so the rate table sizes are assertable: two LiteLLM
 * models and two models.dev go/zen models.
 */
const LITELLM_DOC = {
  "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
  "claude-opus-5": { input_cost_per_token: 5e-5, output_cost_per_token: 2.5e-4 },
};

const MODELS_DEV_DOC = {
  "opencode-go": {
    models: { "deepseek-v4-flash": { cost: { input: 0.07, output: 0.14 } } },
  },
  opencode: {
    models: { "deepseek-v4-flash-free": { cost: { input: 0, output: 0 } } },
  },
};

/**
 * Routes the two rate-table fetches, with the models.dev endpoint failing on
 * its first call. That makes the two sources refresh on different clocks,
 * which is the setup the served-table bug needed: LiteLLM refreshes while the
 * still-fresh models.dev overlay would have been skipped.
 */
function makeFakeHttpClient(): {
  readonly client: HttpClient.HttpClient;
  readonly modelsDevCalls: () => number;
} {
  let modelsDevCalls = 0;
  const json = (request: HttpClientRequest.HttpClientRequest, body: unknown) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  return {
    client: HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.url.includes("litellm")) return json(request, LITELLM_DOC);
        modelsDevCalls += 1;
        if (modelsDevCalls === 1) {
          return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 502 }));
        }
        return json(request, MODELS_DEV_DOC);
      }),
    ),
    modelsDevCalls: () => modelsDevCalls,
  };
}

const INPUT: UsageSummaryInput = {
  sinceDay: Schema.decodeSync(UsageDay)("2026-08-01"),
  untilDay: Schema.decodeSync(UsageDay)("2026-08-31"),
  timeZone: "UTC",
};

function tempDir(prefix: string): string {
  const path = NodePath.join(NodeOS.tmpdir(), `${prefix}-${NodeCrypto.randomUUID()}`);
  NodeFS.mkdirSync(path, { recursive: true });
  return path;
}

it.effect("keeps the models.dev overlay when only the LiteLLM table expires", () => {
  const { client, modelsDevCalls } = makeFakeHttpClient();
  // Point every provider transcript home at a path that does not exist so the
  // scan touches no real data; the assertions only read `knownModels`.
  const missingHome = tempDir("usage-missing");
  const base = tempDir("usage-base");
  const cwd = tempDir("usage-cwd");

  return Effect.gen(function* () {
    const usage = yield* UsageService.make;

    // First scan: LiteLLM loads, models.dev fails -> no overlay yet.
    const first = yield* usage.readSummary(INPUT);
    expect(first.pricing.knownModels).toBe(2);

    // models.dev comes back on the next scan, while LiteLLM is still fresh.
    yield* TestClock.adjust(Duration.hours(1));
    const second = yield* usage.readSummary(INPUT);
    expect(second.pricing.knownModels).toBe(4);

    // Advance past the LiteLLM TTL (24h) but not the models.dev TTL, so a
    // fresh LiteLLM copy is served while the models.dev overlay stays cached.
    yield* TestClock.adjust(Duration.hours(23));
    const third = yield* usage.readSummary(INPUT);
    // Regression: before the fix the served table was the LiteLLM copy alone.
    expect(third.pricing.knownModels).toBe(4);
    expect(modelsDevCalls()).toBe(2);

    return true;
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(HostProcessEnvironment, { OPENCODE_DATA_DIR: missingHome }),
    Effect.provide(ServerConfig.layerTest(cwd, base)),
    Effect.provide(
      ServerSettings.layerTest({
        providers: {
          codex: { homePath: missingHome },
          claudeAgent: { homePath: missingHome },
        },
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});
