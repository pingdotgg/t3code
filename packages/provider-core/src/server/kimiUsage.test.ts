import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { readKimiCodeUsageAccount, type KimiUsageInput } from "./kimiUsage.ts";

const checkedAt = "2026-04-10T00:00:00.000Z";
const input: KimiUsageInput = {
  driver: ProviderDriverKind.make("kimi"),
  credential: { provider: "kimi-main", key: "kimi-key" },
  checkedAt,
};

function fixture(respond: (url: string) => Response) {
  const requests: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      expect(request.headers.authorization).toBe("Bearer kimi-key");
      return HttpClientResponse.fromWeb(request, respond(request.url));
    }),
  );
  return { requests, http };
}

it.effect("maps limit_5h and limit_7d ratios and reset times to session and weekly windows", () =>
  readKimiCodeUsageAccount(input).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      fixture(() =>
        Response.json({
          usages: {
            limit_5h: { used_ratio: 0.25, reset_time: "2026-04-10T05:00:00.000Z" },
            limit_7d: { used_ratio: 0.5, reset_time: "2026-04-16T00:00:00.000Z" },
          },
        }),
      ).http,
    ),
    Effect.map((account) => {
      expect(account).toMatchObject({
        id: "kimi-main",
        driver: ProviderDriverKind.make("kimi"),
        plan: "Kimi Code",
        usageLimits: {
          checkedAt,
          windows: [
            {
              id: "kimi-5h",
              kind: "session",
              label: "Kimi Code 5-hour",
              usedPercent: 25,
              resetsAt: "2026-04-10T05:00:00.000Z",
              windowDurationMins: 300,
            },
            {
              id: "kimi-7d",
              kind: "weekly",
              label: "Kimi Code Weekly",
              usedPercent: 50,
              resetsAt: "2026-04-16T00:00:00.000Z",
              windowDurationMins: 7 * 24 * 60,
            },
          ],
        },
      });
    }),
  ),
);

it.effect("reads the legacy top-level usage and limits payload", () =>
  readKimiCodeUsageAccount(input).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      fixture(() =>
        Response.json({
          usage: { used: 30, limit: 120, resetTime: "2026-04-16T00:00:00.000Z" },
          limits: [
            {
              window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
              detail: { used: 25, limit: 100, resetTime: "2026-04-16T00:00:00.000Z" },
            },
          ],
        }),
      ).http,
    ),
    Effect.map((account) => {
      expect(account.usageLimits).toMatchObject({
        checkedAt,
        windows: [
          {
            id: "kimi-7d",
            kind: "weekly",
            label: "Kimi Code Weekly",
            usedPercent: 25,
            resetsAt: "2026-04-16T00:00:00.000Z",
            windowDurationMins: 7 * 24 * 60,
          },
          {
            id: "kimi-limit-0",
            kind: "weekly",
            label: "Kimi Code Weekly",
            usedPercent: 25,
            resetsAt: "2026-04-16T00:00:00.000Z",
            windowDurationMins: 7 * 24 * 60,
          },
        ],
      });
    }),
  ),
);

it.effect("retries the singular usage endpoint only after a 404", () =>
  Effect.gen(function* () {
    const { requests, http } = fixture((url) =>
      url.endsWith("/usages")
        ? new Response(null, { status: 404 })
        : Response.json({ usages: { limit_5h: { used_ratio: 0.5 } } }),
    );
    const account = yield* readKimiCodeUsageAccount(input).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

    expect(requests).toEqual([
      "https://api.kimi.com/coding/v1/usages",
      "https://api.kimi.com/coding/v1/usage",
    ]);
    expect(account.usageLimits.windows).toEqual([
      {
        id: "kimi-5h",
        kind: "session",
        label: "Kimi Code 5-hour",
        usedPercent: 50,
        windowDurationMins: 300,
      },
    ]);
  }),
);

it.effect("reports probeFailed without retrying after a non-404 failure", () =>
  Effect.gen(function* () {
    const { requests, http } = fixture(() => new Response(null, { status: 500 }));
    const account = yield* readKimiCodeUsageAccount(input).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

    expect(requests).toEqual(["https://api.kimi.com/coding/v1/usages"]);
    expect(account.usageLimits).toMatchObject({
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed", message: "Kimi Code usage limits could not be read." },
    });
  }),
);
