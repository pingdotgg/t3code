import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  VibeProxyUsageService,
  layer,
  normalizeVibeProxyAuthFiles,
} from "./VibeProxyUsageService.ts";

const upstreamAccount = (remainingPercent: number) => ({
  id: "codex-person@example.com.json",
  provider: "codex",
  account: "person@example.com",
  email: "person@example.com",
  label: "Personal",
  account_type: "oauth",
  path: "/root/.cli-proxy-api/codex-person@example.com.json",
  auth_index: "private-routing-index",
  id_token: {
    chatgpt_account_id: "private-account-id",
    plan_type: "pro",
  },
  status: "active",
  disabled: false,
  unavailable: false,
  success: 12,
  failed: 2,
  quota_capacity: {
    provider: "codex",
    supported: true,
    fetched_at: "2026-08-19T07:04:16.021Z",
    stale_at: "2026-08-19T07:14:16.021Z",
    windows: [
      {
        id: "codex-primary",
        label: "Codex primary",
        used_percent: 100 - remainingPercent,
        remaining_percent: remainingPercent,
        reset_at: "2026-08-20T06:47:29Z",
        known: true,
        routing: true,
      },
    ],
  },
  recent_requests: [{ time: "15:00-15:10", success: 4, failed: 1 }],
});

it("normalizes only display-safe Vibe-Proxy auth-file fields", () => {
  const snapshot = normalizeVibeProxyAuthFiles(
    { files: [upstreamAccount(58)] },
    "2026-08-19T07:05:00.000Z",
  );

  assert.isNotNull(snapshot);
  assert.deepEqual(snapshot?.accounts[0], {
    id: "codex-person@example.com.json",
    provider: "codex",
    account: "person@example.com",
    label: "Personal",
    email: "person@example.com",
    accountType: "oauth",
    planType: "pro",
    status: "active",
    statusMessage: null,
    disabled: false,
    unavailable: false,
    success: 12,
    failed: 2,
    recentRequests: [{ time: "15:00-15:10", success: 4, failed: 1 }],
    quotaCapacity: {
      provider: "codex",
      supported: true,
      fetchedAt: "2026-08-19T07:04:16.021Z",
      staleAt: "2026-08-19T07:14:16.021Z",
      lastAttemptAt: null,
      lastError: null,
      windows: [
        {
          id: "codex-primary",
          label: "Codex primary",
          usedPercent: 42,
          remainingPercent: 58,
          resetAt: "2026-08-20T06:47:29Z",
          known: true,
          hardExhausted: false,
          routing: true,
        },
      ],
    },
  });
  const serialized = JSON.stringify(snapshot);
  assert.notInclude(serialized, "/root/.cli-proxy-api");
  assert.notInclude(serialized, "private-routing-index");
  assert.notInclude(serialized, "private-account-id");
});

it.layer(NodeServices.layer)("VibeProxyUsageService", (it) => {
  it.effect("persists fresh quota data and serves it when the next refresh fails", () => {
    let requests = 0;
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests += 1;
        assert.equal(request.url, "http://vibe-proxy.local:8954/api/v0/management/auth-files");
        assert.equal(request.headers.authorization, "Bearer management-key");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            requests === 1
              ? Response.json({ files: [upstreamAccount(58)] })
              : new Response("temporarily unavailable", { status: 503 }),
          ),
        );
      }),
    );
    const serviceLayer = layer.pipe(
      Layer.provide(
        ServerSettings.ServerSettingsService.layerTest({
          vibeProxy: {
            enabled: true,
            baseUrl: "http://vibe-proxy.local:8954",
            apiKey: "management-key",
          },
        }),
      ),
      Layer.provide(httpLayer),
      Layer.provideMerge(
        Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-vibe-proxy-usage-test-" })),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* VibeProxyUsageService;
      const before = yield* service.readCached;
      assert.equal(before.status, "ready");
      assert.isNull(before.snapshot);

      const fresh = yield* service.refresh;
      assert.isTrue(fresh.refreshed);
      assert.equal(fresh.snapshot?.accounts[0]?.quotaCapacity?.windows[0]?.remainingPercent, 58);

      const failed = yield* service.refresh;
      assert.isFalse(failed.refreshed);
      assert.equal(failed.refreshProblem?.reason, "requestFailed");
      assert.equal(failed.snapshot?.accounts[0]?.quotaCapacity?.windows[0]?.remainingPercent, 58);

      const cached = yield* service.readCached;
      assert.equal(cached.snapshot?.accounts[0]?.quotaCapacity?.windows[0]?.remainingPercent, 58);
      assert.equal(requests, 2);
    }).pipe(Effect.provide(serviceLayer));
  });

  it.effect("does not make a request for an invalid base URL", () => {
    let requested = false;
    const serviceLayer = layer.pipe(
      Layer.provide(
        ServerSettings.ServerSettingsService.layerTest({
          vibeProxy: { enabled: true, baseUrl: "file:///tmp/proxy", apiKey: "management-key" },
        }),
      ),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => {
            requested = true;
            return Effect.die("request was not expected");
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-vibe-proxy-invalid-url-test-",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* VibeProxyUsageService;
      const response = yield* service.refresh;
      assert.equal(response.refreshProblem?.reason, "invalidConfiguration");
      assert.isFalse(requested);
    }).pipe(Effect.provide(serviceLayer));
  });
});
