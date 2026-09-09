import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";

import {
  antigravityRateLimitsToLimits,
  antigravityRateLimitsToUpdate,
  antigravityRateLimitsToWindows,
  probeAntigravityUsageLimits,
  quotaSummaryToWindows,
} from "./antigravityUsageLimits.ts";

const checkedAt = "2026-09-09T10:00:00.000Z";

describe("antigravityRateLimitsToWindows", () => {
  it("maps explicit quota windows properly", () => {
    const windows = antigravityRateLimitsToWindows({
      windows: [
        {
          id: "daily_quota",
          kind: "session",
          label: "Daily Quota",
          usedPercent: 42,
          windowDurationMins: 1440,
          resetsAt: "2026-09-10T00:00:00.000Z",
        },
      ],
    });

    expect(windows).toEqual([
      {
        id: "daily_quota",
        kind: "session",
        label: "Daily Quota",
        usedPercent: 42,
        windowDurationMins: 1440,
        resetsAt: "2026-09-10T00:00:00.000Z",
      },
    ]);
  });

  it("calculates usage percentage from prompt credits", () => {
    const windows = antigravityRateLimitsToWindows({
      monthlyPromptCredits: 1000,
      availablePromptCredits: 600,
    });

    expect(windows).toEqual([
      {
        id: "prompt_credits",
        kind: "monthly",
        label: "Prompt Credits",
        usedPercent: 40,
        windowDurationMins: 43200,
      },
    ]);
  });

  it("calculates usage percentage from flow credits", () => {
    const windows = antigravityRateLimitsToWindows({
      monthlyFlowCredits: 500,
      availableFlowCredits: 100,
    });

    expect(windows).toEqual([
      {
        id: "flow_credits",
        kind: "monthly",
        label: "Flow Credits",
        usedPercent: 80,
        windowDurationMins: 43200,
      },
    ]);
  });

  it("creates a plan allowance window for recognized tiers", () => {
    const windows = antigravityRateLimitsToWindows({
      allowedTiers: [
        {
          id: "standard-tier",
          name: "Gemini Code Assist",
          description: "Unlimited coding assistant with the most powerful Gemini models",
        },
      ],
    });

    expect(windows).toEqual([
      {
        id: "plan_allowance",
        kind: "session",
        label: "Gemini Code Assist",
        usedPercent: 0,
      },
    ]);
  });
});

describe("antigravityRateLimitsToLimits", () => {
  it("wraps windows into ServerProviderUsageLimits with checkedAt", () => {
    const limits = antigravityRateLimitsToLimits({
      checkedAt,
      snapshot: {
        monthlyPromptCredits: 100,
        availablePromptCredits: 75,
      },
    });

    expect(limits).toEqual({
      checkedAt,
      windows: [
        {
          id: "prompt_credits",
          kind: "monthly",
          label: "Prompt Credits",
          usedPercent: 25,
          windowDurationMins: 43200,
        },
      ],
    });
  });
});

describe("antigravityRateLimitsToUpdate", () => {
  it("produces a ProviderUsageLimitsUpdate when windows exist", () => {
    const update = antigravityRateLimitsToUpdate({
      monthlyPromptCredits: 100,
      availablePromptCredits: 50,
    });

    expect(update).toEqual({
      windows: [
        {
          id: "prompt_credits",
          kind: "monthly",
          label: "Prompt Credits",
          usedPercent: 50,
          windowDurationMins: 43200,
        },
      ],
    });
  });

  it("returns undefined when no windows exist", () => {
    const update = antigravityRateLimitsToUpdate({});
    expect(update).toBeUndefined();
  });
});

describe("quotaSummaryToWindows", () => {
  it("maps Gemini and Claude/GPT model groups into 5-hour and weekly windows", () => {
    const windows = quotaSummaryToWindows({
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-09-11T06:06:12Z",
              remainingFraction: 0.6348,
            },
            {
              bucketId: "gemini-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              resetTime: "2026-09-09T11:13:01Z",
              remainingFraction: 0.5346,
            },
          ],
        },
        {
          displayName: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              bucketId: "3p-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-09-16T06:14:10Z",
              remainingFraction: 1,
            },
            {
              bucketId: "3p-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              resetTime: "2026-09-09T11:14:10Z",
              remainingFraction: 1,
            },
          ],
        },
      ],
    });

    expect(windows).toEqual([
      {
        id: "gemini-5h",
        label: "Gemini (5-hour)",
        kind: "session",
        usedPercent: 47,
        windowDurationMins: 300,
        resetsAt: "2026-09-09T11:13:01.000Z",
      },
      {
        id: "gemini-weekly",
        label: "Gemini (Weekly)",
        kind: "weekly",
        usedPercent: 37,
        windowDurationMins: 10080,
        resetsAt: "2026-09-11T06:06:12.000Z",
      },
      {
        id: "3p-5h",
        label: "Claude & GPT (5-hour)",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: "2026-09-09T11:14:10.000Z",
      },
      {
        id: "3p-weekly",
        label: "Claude & GPT (Weekly)",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
        resetsAt: "2026-09-16T06:14:10.000Z",
      },
    ]);
  });

  it("ignores disabled buckets and handles malformed inputs safely", () => {
    const windows = quotaSummaryToWindows({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "disabled-bucket",
              displayName: "Disabled Limit",
              window: "5h",
              disabled: true,
              remainingFraction: 0.5,
            },
            {
              bucketId: "gemini-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              resetTime: "invalid-date",
              remainingFraction: NaN,
            },
          ],
        },
      ],
    });

    expect(windows).toEqual([
      {
        id: "gemini-5h",
        label: "Gemini (5-hour)",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      },
    ]);

    expect(quotaSummaryToWindows(null)).toEqual([]);
    expect(quotaSummaryToWindows(undefined)).toEqual([]);
  });
});

describe("probeAntigravityUsageLimits", () => {
  it.effect("returns undefined when token file does not exist", () =>
    Effect.gen(function* () {
      const mockHttp = HttpClient.make(() => Effect.die("HTTP should not be called"));
      const result = yield* probeAntigravityUsageLimits({
        profileDirectory: "/nonexistent/profile",
        checkedAt,
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(HttpClient.HttpClient, mockHttp),
      );

      expect(result).toBeUndefined();
    }),
  );

  it.effect("rejects untrusted token_uri to prevent SSRF", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      const acpDir = path.join(tempDir, "antigravity-acp");
      yield* fs.makeDirectory(acpDir);

      yield* fs.writeFileString(
        path.join(acpDir, "acp_token.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          client_id: "id",
          client_secret: "secret",
          refresh_token: "refresh",
          token_uri: "http://malicious-server.com/token",
        }),
      );

      const mockHttp = HttpClient.make(() => Effect.die("HTTP should not be called"));
      const result = yield* probeAntigravityUsageLimits({
        profileDirectory: tempDir,
        checkedAt,
      }).pipe(Effect.provideService(HttpClient.HttpClient, mockHttp));

      expect(result).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("exchanges token and probes quota summary successfully", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      const acpDir = path.join(tempDir, "antigravity-acp");
      yield* fs.makeDirectory(acpDir);

      yield* fs.writeFileString(
        path.join(acpDir, "acp_token.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          client_id: "id",
          client_secret: "secret",
          refresh_token: "refresh",
          token_uri: "https://oauth2.googleapis.com/token",
        }),
      );

      const mockHttp = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = request.url;
          if (url === "https://oauth2.googleapis.com/token") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "mock-access-token" }),
            );
          }
          if (url.includes("retrieveUserQuotaSummary")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                groups: [
                  {
                    displayName: "Gemini Models",
                    buckets: [
                      {
                        bucketId: "gemini-5h",
                        displayName: "Five Hour Limit Remaining",
                        window: "5h",
                        resetTime: "2026-09-09T15:00:00.000Z",
                        remainingFraction: 0.75,
                      },
                    ],
                  },
                ],
              }),
            );
          }
          return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
        }),
      );

      const result = yield* probeAntigravityUsageLimits({
        profileDirectory: tempDir,
        checkedAt,
      }).pipe(Effect.provideService(HttpClient.HttpClient, mockHttp));

      expect(result).toBeDefined();
      expect(result?.windows).toHaveLength(1);
      expect(result?.windows[0]?.id).toBe("gemini-5h");
      expect(result?.windows[0]?.usedPercent).toBe(25);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("probes and orders multi-group quota summary buckets grouped by model family", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      const acpDir = path.join(tempDir, "antigravity-acp");
      yield* fs.makeDirectory(acpDir);

      yield* fs.writeFileString(
        path.join(acpDir, "acp_token.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          client_id: "id",
          client_secret: "secret",
          refresh_token: "refresh",
          token_uri: "https://oauth2.googleapis.com/token",
        }),
      );

      const mockHttp = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = request.url;
          if (url === "https://oauth2.googleapis.com/token") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "mock-access-token" }),
            );
          }
          if (url.includes("retrieveUserQuotaSummary")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                groups: [
                  {
                    displayName: "Gemini Models",
                    buckets: [
                      {
                        bucketId: "gemini-weekly",
                        displayName: "Weekly Limit Remaining",
                        window: "weekly",
                        remainingFraction: 0.6,
                      },
                      {
                        bucketId: "gemini-5h",
                        displayName: "Five Hour Limit Remaining",
                        window: "5h",
                        remainingFraction: 0.7,
                      },
                    ],
                  },
                  {
                    displayName: "Claude and GPT models",
                    buckets: [
                      {
                        bucketId: "3p-weekly",
                        displayName: "Weekly Limit Remaining",
                        window: "weekly",
                        remainingFraction: 1,
                      },
                      {
                        bucketId: "3p-5h",
                        displayName: "Five Hour Limit Remaining",
                        window: "5h",
                        remainingFraction: 1,
                      },
                    ],
                  },
                ],
              }),
            );
          }
          return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
        }),
      );

      const result = yield* probeAntigravityUsageLimits({
        profileDirectory: tempDir,
        checkedAt,
      }).pipe(Effect.provideService(HttpClient.HttpClient, mockHttp));

      expect(result).toBeDefined();
      expect(result?.windows.map((w) => w.label)).toEqual([
        "Gemini (5-hour)",
        "Gemini (Weekly)",
        "Claude & GPT (5-hour)",
        "Claude & GPT (Weekly)",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to loadCodeAssist when retrieveUserQuotaSummary fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      const acpDir = path.join(tempDir, "antigravity-acp");
      yield* fs.makeDirectory(acpDir);

      yield* fs.writeFileString(
        path.join(acpDir, "acp_token.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          client_id: "id",
          client_secret: "secret",
          refresh_token: "refresh",
          token_uri: "https://oauth2.googleapis.com/token",
        }),
      );

      const mockHttp = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = request.url;
          if (url === "https://oauth2.googleapis.com/token") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "mock-access-token" }),
            );
          }
          if (url.includes("retrieveUserQuotaSummary")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "unavailable" }, { status: 500 }),
            );
          }
          if (url.includes("loadCodeAssist")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                allowedTiers: [{ id: "standard", name: "Gemini Code Assist" }],
                quotaManagerState: {
                  monthlyPromptCredits: 100,
                  availablePromptCredits: 70,
                },
              }),
            );
          }
          return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
        }),
      );

      const result = yield* probeAntigravityUsageLimits({
        profileDirectory: tempDir,
        checkedAt,
      }).pipe(Effect.provideService(HttpClient.HttpClient, mockHttp));

      expect(result).toBeDefined();
      expect(result?.windows).toHaveLength(1);
      expect(result?.windows[0]?.id).toBe("prompt_credits");
      expect(result?.windows[0]?.usedPercent).toBe(30);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns undefined when token exchange returns 401", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      const acpDir = path.join(tempDir, "antigravity-acp");
      yield* fs.makeDirectory(acpDir);

      yield* fs.writeFileString(
        path.join(acpDir, "acp_token.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          client_id: "id",
          client_secret: "secret",
          refresh_token: "revoked-refresh-token",
          token_uri: "https://oauth2.googleapis.com/token",
        }),
      );

      const mockHttp = HttpClient.make((request) =>
        Effect.sync(() => {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "invalid_grant" }, { status: 401 }),
          );
        }),
      );

      const result = yield* probeAntigravityUsageLimits({
        profileDirectory: tempDir,
        checkedAt,
      }).pipe(Effect.provideService(HttpClient.HttpClient, mockHttp));

      expect(result).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
