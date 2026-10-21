import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { readKimiUsageLimits } from "./usageLimits.ts";

const reset = "2026-10-21T10:00:00Z";
const window = { used_ratio: 0.25, reset_time: reset };
const usages = { limit_5h: window, limit_month_total: window, limit_month_code: window };
const input = {
  enabled: true,
  serverUrl: "",
  environment: {
    OPENCODE_AUTH_CONTENT: JSON.stringify({
      "kimi-for-coding": { type: "api", key: "test-kimi-key" },
    }),
  },
};

it.effect("binds the global Kimi route to its own inline credential and canonical host", () =>
  Effect.gen(function* () {
    for (const model of ["k3", "kimi-for-coding-highspeed"]) {
      const limits = yield* readKimiUsageLimits({
        ...input,
        providerId: "kimi-code-plan-global",
        environment: {
          KIMI_API_KEY: "wrong-environment-key",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            enabled_providers: ["kimi-code-plan-global"],
            model: `kimi-code-plan-global/${model}`,
          }),
          OPENCODE_AUTH_CONTENT: JSON.stringify({
            "kimi-for-coding": { type: "api", key: "wrong-regional-key" },
            "kimi-code-plan-global": { type: "api", key: "global-test-key" },
          }),
        },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            assert.equal(request.url, "https://api.kimi.ai/coding/v1/usages");
            assert.equal(request.headers.authorization, "Bearer global-test-key");
            return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ usages })));
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
      assert.isUndefined(limits.unavailable);
      assert.lengthOf(limits.windows, 3);
    }
  }),
);

it.effect(
  "does not substitute regional credentials, an opaque wrapper, OAuth, or a custom endpoint for global Kimi",
  () =>
    Effect.gen(function* () {
      for (const environment of [
        input.environment,
        { OPENCODE_AUTH_CONTENT: "{}" },
        { KIMI_API_KEY: "database-may-override-this-key" },
        {
          OPENCODE_AUTH_CONTENT: JSON.stringify({
            "kimi-code-plan-global": { type: "oauth", access: "not-an-api-key" },
          }),
        },
        {
          ...input.environment,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: {
              "kimi-code-plan-global": {
                options: { baseURL: "https://example.com/coding/v1", apiKey: "never-send" },
              },
            },
          }),
        },
      ]) {
        const limits = yield* readKimiUsageLimits({
          ...input,
          providerId: "kimi-code-plan-global",
          environment,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not probe another credential or endpoint")),
          ),
          Effect.provide(NodeServices.layer),
        );
        assert.equal(limits.unavailable?.reason, "unsupported");
      }
    }),
);

it.effect(
  "reads Kimi subscription usage without a generation request and fingerprints the runtime credential",
  () =>
    Effect.gen(function* () {
      const limits = yield* readKimiUsageLimits(input).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            assert.equal(request.method, "GET");
            assert.equal(request.url, "https://api.kimi.com/coding/v1/usages");
            assert.equal(request.headers.authorization, "Bearer test-kimi-key");
            return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ usages })));
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
      assert.isUndefined(limits.unavailable);
      assert.deepEqual(
        limits.windows.map((w) => [w.id, w.usedPercent]),
        [
          ["limit_5h", 25],
          ["limit_month_code", 25],
          ["limit_month_total", 25],
        ],
      );
      assert.match(limits.credentialFingerprint ?? "", /^[a-f0-9]{64}$/);
    }),
);

it.effect(
  "rejects partial, malformed, and error responses instead of treating them as healthy",
  () =>
    Effect.gen(function* () {
      for (const body of [
        {},
        { usages: { limit_5h: window } },
        { usages: { ...usages, limit_5h: { ...window, used_ratio: -1 } } },
        { usages: { ...usages, limit_5h: { ...window, used_ratio: 1.2 } } },
        { usages: { ...usages, limit_5h: { ...window, reset_time: "bad" } } },
      ]) {
        const limits = yield* readKimiUsageLimits(input).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body))),
            ),
          ),
          Effect.provide(NodeServices.layer),
        );
        assert.equal(limits.unavailable?.reason, "probeFailed");
        assert.lengthOf(limits.windows, 0);
      }
    }),
);

it.effect("does not probe remote runtime accounts with local credentials", () =>
  Effect.gen(function* () {
    const limits = yield* readKimiUsageLimits({
      ...input,
      serverUrl: "https://external.invalid",
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("remote runtime cannot use local auth")),
      ),
      Effect.provide(NodeServices.layer),
    );
    assert.equal(limits.unavailable?.reason, "unsupported");
  }),
);

it.effect("bounds a hung Kimi usage request", () =>
  Effect.gen(function* () {
    const fiber = yield* readKimiUsageLimits(input).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.never),
      ),
      Effect.provide(NodeServices.layer),
      Effect.forkChild,
    );
    yield* TestClock.adjust("5 seconds");
    const limits = yield* Fiber.join(fiber);
    assert.equal(limits.unavailable?.reason, "probeFailed");
  }),
);
