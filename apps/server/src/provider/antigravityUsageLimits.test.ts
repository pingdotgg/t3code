import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { makeAntigravityUsageProbe } from "./antigravityUsageLimits.ts";

const summary = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          remainingFraction: 0.96,
          resetTime: "2026-10-12T19:41:43Z",
        },
        {
          bucketId: "gemini-5h",
          window: "5h",
          remainingFraction: 0.91,
          resetTime: "2026-10-09T16:06:01Z",
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          window: "weekly",
          remainingFraction: 0,
          resetTime: "2026-10-10T15:28:22Z",
        },
        {
          bucketId: "3p-5h",
          window: "5h",
          remainingFraction: 0.44,
          resetTime: "2026-10-09T16:06:30Z",
        },
      ],
    },
  ],
};

const fixture = Effect.fn("AntigravityUsageTest.fixture")(function* (
  options: {
    summary?: unknown;
    models?: unknown;
    summaryStatus?: number;
    tokenStatus?: number;
    missingToken?: boolean;
    authMethod?: "oauth-personal" | "gemini-api-key";
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileDirectory = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(profileDirectory, "antigravity-acp"));
  const tokenPath = path.join(profileDirectory, "antigravity-acp", "acp_token.json");
  const writeToken = (refreshToken: string) =>
    fs.writeFileString(
      tokenPath,
      JSON.stringify({
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: refreshToken,
        project_id: "project-id",
      }),
    );
  if (!options.missingToken) yield* writeToken("refresh-a");
  const requests: Array<{ url: string; body: string }> = [];
  const http = HttpClient.make((request, _url, _signal, fiber) =>
    Effect.sync(() => {
      const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
      expect(init?.redirect).toBe("manual");
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ url: request.url, body });
      if (request.url.endsWith("/token")) {
        expect(new URLSearchParams(body).get("grant_type")).toBe("refresh_token");
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { access_token: "access-token", expires_in: 3600 },
            { status: options.tokenStatus ?? 200 },
          ),
        );
      }
      expect(request.headers.authorization).toBe("Bearer access-token");
      expect(JSON.parse(body)).toEqual({ project: "project-id" });
      return HttpClientResponse.fromWeb(
        request,
        request.url.endsWith(":retrieveUserQuotaSummary")
          ? Response.json(options.summary ?? summary, { status: options.summaryStatus ?? 200 })
          : Response.json(options.models ?? { models: {} }),
      );
    }),
  );
  const usage = yield* makeAntigravityUsageProbe({
    profileDirectory,
    authMethod: options.authMethod ?? "oauth-personal",
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
  return { ...usage, requests, writeToken, tokenPath };
});

describe("Antigravity subscription limits", () => {
  it.effect("reports separate Gemini and shared Claude/GPT five-hour and weekly limits", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture();
      const limits = yield* probe;
      expect(limits.windows).toHaveLength(4);
      expect(limits.unavailable).toBeUndefined();
      expect(limits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.usedPercent).toBeCloseTo(4);
      expect(byId.get("gemini-5h")?.usedPercent).toBeCloseTo(9);
      expect(byId.get("3p-weekly")).toMatchObject({
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: "2026-10-10T15:28:22.000Z",
      });
      expect(byId.get("3p-5h")).toMatchObject({ kind: "session", windowDurationMins: 300 });
      expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(56);
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
      expect(
        requests.filter((request) => request.url.endsWith(":retrieveUserQuotaSummary")),
      ).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("re-reads changed credentials and clears cached access after sign-out", () =>
    Effect.gen(function* () {
      const { probe, clear, requests, writeToken, tokenPath } = yield* fixture();
      const first = yield* probe;
      yield* writeToken("refresh-b");
      const second = yield* probe;
      expect(second.credentialFingerprint).not.toBe(first.credentialFingerprint);
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2);
      yield* (yield* FileSystem.FileSystem).remove(tokenPath);
      expect((yield* probe).unavailable?.reason).toBe("unsupported");
      yield* writeToken("refresh-b");
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(3);
      yield* clear;
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to model quotas without inventing a window duration", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryStatus: 404,
        models: {
          models: {
            "gemini-a": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-10T12:00:00Z" },
            },
            "gemini-b": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.6, resetTime: "2026-10-10T12:00:00Z" },
            },
            "claude-a": { quotaInfo: { remainingFraction: 0.2 } },
          },
        },
      });
      const limits = yield* probe;
      expect(limits.windows).toHaveLength(2);
      expect(limits.windows.find((window) => window.id === "gemini-quota")?.usedPercent).toBe(40);
      expect(
        limits.windows.every(
          (window) => window.kind === "other" && window.windowDurationMins === undefined,
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips disabled and missing fractions and clamps valid percentages", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            { bucketId: "disabled", remainingFraction: 0, disabled: true },
            { bucketId: "missing", resetTime: "2026-10-10T12:00:00Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 2, resetTime: "invalid" },
          ],
        },
      });
      expect((yield* probe).windows).toEqual([
        {
          id: "gemini-5h",
          kind: "session",
          label: "Gemini · 5-hour",
          usedPercent: 0,
          windowDurationMins: 300,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves cached access token when quota endpoints return no usable windows", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture({
        summary: { groups: [] },
        models: { models: {} },
      });
      const first = yield* probe;
      expect(first.unavailable?.reason).toBe("probeFailed");
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
      const second = yield* probe;
      expect(second.unavailable?.reason).toBe("probeFailed");
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns a safe failure when OAuth refresh fails", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({ tokenStatus: 401 });
      const limits = yield* probe;
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(JSON.stringify(limits)).not.toMatch(/client-secret|refresh-a|access-token/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not make network requests for API keys or missing sign-ins", () =>
    Effect.gen(function* () {
      for (const options of [{ authMethod: "gemini-api-key" as const }, { missingToken: true }]) {
        const { probe, requests } = yield* fixture(options);
        expect((yield* probe).unavailable?.reason).toBe("unsupported");
        expect(requests).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
