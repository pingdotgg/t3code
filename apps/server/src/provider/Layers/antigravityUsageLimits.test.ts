import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import type { AntigravityAuthMethod } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  antigravityQuotaSummaryToLimits,
  makeAntigravityUsageLimits,
} from "./antigravityUsageLimits.ts";

const summary = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          remainingFraction: 0.25,
          resetTime: "2026-10-07T00:00:00Z",
        },
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.75 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0 },
        { bucketId: "3p-5h", window: "5h", remainingFraction: 1 },
      ],
    },
  ],
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const credentials = { client_id: "client", client_secret: "secret", refresh_token: "account-a" };
const makeFixture = Effect.fn("antigravityUsageFixture")(function* (input: {
  readonly contents?: string;
  readonly authMethod?: AntigravityAuthMethod;
  readonly enabled?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const tokenPath = path.join(directory, "acp_token.json");
  if (input.contents !== undefined) yield* fs.writeFileString(tokenPath, input.contents);
  const reader = yield* makeAntigravityUsageLimits({
    enabled: input.enabled ?? true,
    authMethod: input.authMethod ?? "oauth-personal",
    tokenPath,
  });
  return { fs, tokenPath, ...reader };
});

describe("Antigravity subscription limits", () => {
  it("keeps Gemini and third-party allowances separate, including exhausted and unused buckets", () => {
    const limits = antigravityQuotaSummaryToLimits(summary, "2026-10-03T00:00:00.000Z");
    expect(limits.windows).toHaveLength(4);
    expect(limits.windows.find((window) => window.id === "gemini-weekly")).toEqual({
      id: "gemini-weekly",
      kind: "weekly",
      label: "Gemini · Weekly",
      usedPercent: 75,
      windowDurationMins: 10_080,
      resetsAt: "2026-10-07T00:00:00.000Z",
    });
    expect(limits.windows.find((window) => window.id === "3p-weekly")?.usedPercent).toBe(100);
    expect(limits.windows.find((window) => window.id === "3p-5h")?.usedPercent).toBe(0);
  });

  it("does not invent an allowance for missing fractions or unknown windows", () => {
    const limits = antigravityQuotaSummaryToLimits(
      {
        groups: [
          {
            buckets: [
              { bucketId: "gemini-5h", window: "5h" },
              { bucketId: "future", window: "future", remainingFraction: 1 },
            ],
          },
        ],
      },
      "2026-10-03T00:00:00.000Z",
    );
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable?.reason).toBe("probeFailed");
  });

  it.effect(
    "refreshes only this profile's credentials, caches the token, and never writes it back",
    () =>
      Effect.gen(function* () {
        const contents = encodeJson({
          ...credentials,
          token_uri: "https://untrusted.example/token",
        });
        const fixture = yield* makeFixture({ contents });
        let refreshes = 0;
        let quotas = 0;
        const client = HttpClient.make((request) => {
          if (request.url === "https://oauth2.googleapis.com/token") {
            refreshes++;
            expect(request.headers["content-type"]).toContain("application/x-www-form-urlencoded");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ access_token: "fresh-token", expires_in: 3600 }),
              ),
            );
          }
          quotas++;
          expect(request.url).toBe(
            "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
          );
          expect(request.headers.authorization).toBe("Bearer fresh-token");
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(summary)));
        });
        const first = yield* fixture.read.pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        const second = yield* fixture.read.pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect(refreshes).toBe(1);
        expect(quotas).toBe(2);
        expect(yield* fixture.credentialFingerprint).toBe(first.credentialFingerprint);
        expect(first.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(second.credentialFingerprint).toBe(first.credentialFingerprint);
        expect(yield* fixture.fs.readFileString(fixture.tokenPath)).toBe(contents);
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected request")),
        ),
      ),
  );

  it.effect(
    "reads account identity locally and detects replaced, missing, or invalid credentials",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ contents: encodeJson(credentials) });
        const first = yield* fixture.credentialFingerprint;
        expect(first).toMatch(/^[a-f0-9]{64}$/);
        yield* fixture.fs.writeFileString(
          fixture.tokenPath,
          encodeJson({ ...credentials, refresh_token: "account-b" }),
        );
        expect(yield* fixture.credentialFingerprint).not.toBe(first);
        yield* fixture.fs.writeFileString(fixture.tokenPath, "invalid json");
        expect(yield* fixture.credentialFingerprint).toBeUndefined();
        yield* fixture.fs.remove(fixture.tokenPath);
        expect(yield* fixture.credentialFingerprint).toBeUndefined();
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retries an expired stored access token once", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        contents: encodeJson({ ...credentials, token: "expired" }),
      });
      const urls: string[] = [];
      const client = HttpClient.make((request) => {
        urls.push(request.url);
        const response =
          request.url === "https://oauth2.googleapis.com/token"
            ? Response.json({ access_token: "renewed", expires_in: 3600 })
            : request.headers.authorization === "Bearer expired"
              ? new Response("", { status: 401 })
              : Response.json(summary);
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const limits = yield* fixture.read.pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(limits.windows).toHaveLength(4);
      expect(urls).toHaveLength(3);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected request")),
      ),
    ),
  );

  it.effect.each(["gemini-api-key", "agent-platform", "oauth-business"] as const)(
    "does not query personal subscription quotas for %s",
    (authMethod) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ authMethod, contents: encodeJson(credentials) });
        expect((yield* fixture.read).unavailable?.reason).toBe("unsupported");
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not request quota")),
        ),
      ),
  );

  it.effect.each([403, 500] as const)("reports a failed probe for HTTP %s", (status) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        contents: encodeJson({ ...credentials, access_token: "token" }),
      });
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("private error", { status })),
        ),
      );
      const limits = yield* fixture.read.pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(limits.credentialFingerprint).toBe(yield* fixture.credentialFingerprint);
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Antigravity could not read usage limits.",
      });
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected request")),
      ),
    ),
  );

  it.effect("invalidates the cached token when the profile changes accounts", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ contents: encodeJson(credentials) });
      let refreshes = 0;
      const client = HttpClient.make((request) => {
        const response =
          request.url === "https://oauth2.googleapis.com/token"
            ? Response.json({ access_token: `token-${++refreshes}`, expires_in: 3600 })
            : Response.json(summary);
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const first = yield* fixture.read.pipe(Effect.provideService(HttpClient.HttpClient, client));
      yield* fixture.fs.writeFileString(
        fixture.tokenPath,
        encodeJson({ ...credentials, refresh_token: "account-b" }),
      );
      const second = yield* fixture.read.pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(refreshes).toBe(2);
      expect(first.credentialFingerprint).not.toBe(second.credentialFingerprint);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected request")),
      ),
    ),
  );
});
