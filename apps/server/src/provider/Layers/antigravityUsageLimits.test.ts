import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  antigravityQuotaSummaryToLimits,
  antigravityUsageLimitsSupported,
  readAntigravityUsageLimits,
} from "./antigravityUsageLimits.ts";

const CHECKED_AT = "2026-09-18T12:00:00.000Z";
const RESETS_AT = "2026-09-18T17:00:00.000Z";

const liveSummary = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          remainingFraction: 0.8187191,
          resetTime: RESETS_AT,
        },
        {
          bucketId: "gemini-5h",
          window: "5h",
          remainingFraction: 0.9798726,
          resetTime: RESETS_AT,
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: RESETS_AT },
        { bucketId: "3p-5h", window: "5h", remainingFraction: 0.4, resetTime: RESETS_AT },
      ],
    },
  ],
};

it("maps only Gemini session and weekly windows and ignores Claude and GPT pools", () => {
  const limits = antigravityQuotaSummaryToLimits(liveSummary, CHECKED_AT);
  NodeAssert.equal(limits.unavailable, undefined);
  NodeAssert.deepEqual(
    limits.windows.map((window) => ({
      id: window.id,
      kind: window.kind,
      label: window.label,
      usedPercent: Math.round(window.usedPercent),
      mins: window.windowDurationMins,
      reset: window.resetsAt,
    })),
    [
      {
        id: "gemini_five_hour",
        kind: "session",
        label: "Gemini · Session",
        usedPercent: 2,
        mins: 5 * 60,
        reset: RESETS_AT,
      },
      {
        id: "gemini_seven_day",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 18,
        mins: 7 * 24 * 60,
        reset: RESETS_AT,
      },
    ],
  );
});

it("reports unsupported when Cloud Code only returns third-party model pools", () => {
  const limits = antigravityQuotaSummaryToLimits(
    {
      groups: [
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: RESETS_AT },
            { bucketId: "3p-5h", window: "5h", remainingFraction: 0.4, resetTime: RESETS_AT },
          ],
        },
      ],
    },
    CHECKED_AT,
  );
  NodeAssert.equal(limits.unavailable?.reason, "unsupported");
  NodeAssert.deepEqual(limits.windows, []);
});

it("reads nested remainingFraction and ignores buckets that have no window", () => {
  const limits = antigravityQuotaSummaryToLimits(
    {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-5h", remaining: { remainingFraction: 0.5 } },
            { bucketId: "gemini-unknown", remainingFraction: 0.1 },
          ],
        },
      ],
    },
    CHECKED_AT,
  );
  NodeAssert.deepEqual(
    limits.windows.map((window) => window.id),
    ["gemini_five_hour"],
  );
  NodeAssert.equal(limits.windows[0]?.usedPercent, 50);
});

it("treats API-key and Vertex methods as having no subscription windows", () => {
  NodeAssert.equal(antigravityUsageLimitsSupported("oauth-personal"), true);
  NodeAssert.equal(antigravityUsageLimitsSupported("oauth-business"), true);
  NodeAssert.equal(antigravityUsageLimitsSupported("gemini-api-key"), false);
  NodeAssert.equal(antigravityUsageLimitsSupported("agent-platform"), false);
});

it.effect("reads the instance token file and sends Cloud Code the Antigravity user agent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const tokenPath = path.join(directory, "acp_token.json");
    yield* fs.writeFileString(tokenPath, '{"token":{"access_token":"ya29.instance-token"}}');
    const limits = yield* readAntigravityUsageLimits({
      enabled: true,
      authMethod: "oauth-personal",
      tokenPath,
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          NodeAssert.equal(
            request.url,
            "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
          );
          NodeAssert.equal(request.headers.authorization, "Bearer ya29.instance-token");
          NodeAssert.equal(request.headers["user-agent"], "antigravity");
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(liveSummary)));
        }),
      ),
    );
    NodeAssert.deepEqual(
      limits.windows.map((window) => window.id),
      ["gemini_five_hour", "gemini_seven_day"],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("exchanges the stored refresh token before reading Cloud Code quota", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const tokenPath = path.join(directory, "acp_token.json");
    yield* fs.writeFileString(
      tokenPath,
      '{"client_id":"client.apps.googleusercontent.com","client_secret":"client-secret","refresh_token":"refresh-token","token_uri":"https://oauth2.googleapis.com/token","project_id":"default-cli-project","scopes":["https://www.googleapis.com/auth/cloud-platform"]}',
    );
    const urls: string[] = [];
    const limits = yield* readAntigravityUsageLimits({
      enabled: true,
      authMethod: "oauth-personal",
      tokenPath,
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          urls.push(request.url);
          if (request.url === "https://oauth2.googleapis.com/token") {
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            NodeAssert.match(body, /grant_type=refresh_token/);
            NodeAssert.match(body, /refresh_token=refresh-token/);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ access_token: "ya29.from-refresh", expires_in: 3600 }),
              ),
            );
          }
          NodeAssert.equal(request.headers.authorization, "Bearer ya29.from-refresh");
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(liveSummary)));
        }),
      ),
    );
    NodeAssert.deepEqual(urls, [
      "https://oauth2.googleapis.com/token",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ]);
    NodeAssert.deepEqual(
      limits.windows.map((window) => window.id),
      ["gemini_five_hour", "gemini_seven_day"],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("does not send refresh credentials to a non-Google token URI", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const tokenPath = path.join(directory, "acp_token.json");
    yield* fs.writeFileString(
      tokenPath,
      '{"client_id":"client.apps.googleusercontent.com","client_secret":"client-secret","refresh_token":"refresh-token","token_uri":"https://evil.example/token"}',
    );
    const limits = yield* readAntigravityUsageLimits({
      enabled: true,
      authMethod: "oauth-personal",
      tokenPath,
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unsafe token URI must not be called")),
      ),
    );
    NodeAssert.equal(limits.unavailable?.reason, "unsupported");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("sends the Gemini Enterprise project and accepts a flat access_token file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const tokenPath = path.join(directory, "acp_token.json");
    yield* fs.writeFileString(tokenPath, '{"access_token":"ya29.enterprise"}');
    let body = "";
    const limits = yield* readAntigravityUsageLimits({
      enabled: true,
      authMethod: "oauth-business",
      tokenPath,
      gcpProject: "my-gcp-project",
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(liveSummary)));
        }),
      ),
    );
    NodeAssert.equal(body, '{"project":"my-gcp-project"}');
    NodeAssert.equal(limits.unavailable, undefined);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("does not read tokens for disabled instances or API-key methods", () =>
  Effect.gen(function* () {
    for (const input of [
      { enabled: false, authMethod: "oauth-personal" as const },
      { enabled: true, authMethod: "gemini-api-key" as const },
      { enabled: true, authMethod: "agent-platform" as const },
    ]) {
      const limits = yield* readAntigravityUsageLimits({
        ...input,
        tokenPath: "/missing/acp_token.json",
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("unexpected credential read"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected usage request")),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, "unsupported");
      NodeAssert.deepEqual(limits.windows, []);
    }
  }),
);

it.effect("keeps missing entitlement distinct from failed or malformed usage responses", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const tokenPath = path.join(directory, "acp_token.json");
    yield* fs.writeFileString(tokenPath, '{"token":{"access_token":"ya29.token"}}');
    for (const [status, reason, payload] of [
      [403, "unsupported", {}],
      [200, "unsupported", {}],
      [401, "probeFailed", {}],
      [200, "probeFailed", { groups: true }],
    ] as const) {
      const limits = yield* readAntigravityUsageLimits({
        enabled: true,
        authMethod: "oauth-personal",
        tokenPath,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(payload, { status }))),
          ),
        ),
      );
      NodeAssert.equal(limits.unavailable?.reason, reason);
      NodeAssert.deepEqual(limits.windows, []);
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("reports unsupported when the instance has not signed in yet", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const limits = yield* readAntigravityUsageLimits({
      enabled: true,
      authMethod: "oauth-personal",
      tokenPath: path.join(directory, "missing.json"),
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("missing tokens must not hit Cloud Code")),
      ),
    );
    NodeAssert.equal(limits.unavailable?.reason, "unsupported");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
