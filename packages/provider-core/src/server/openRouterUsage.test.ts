import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { readOpenRouterUsageAccount, type OpenRouterUsageInput } from "./openRouterUsage.ts";

const checkedAt = "2026-04-10T00:00:00.000Z";
const input: OpenRouterUsageInput = {
  driver: ProviderDriverKind.make("openrouter"),
  credential: { provider: "openrouter-main", key: "openrouter-key" },
  checkedAt,
};

function fixture(respond: (url: string) => Response) {
  const requests: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      expect(request.headers.authorization).toBe("Bearer openrouter-key");
      return HttpClientResponse.fromWeb(request, respond(request.url));
    }),
  );
  return { requests, http };
}

it.effect(
  "maps usage, limit, and limit_remaining to monetary usage and a credit-limit window",
  () =>
    readOpenRouterUsageAccount(input).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        fixture(() =>
          Response.json({
            data: { label: "main", usage: 25, limit: 100, limit_remaining: 75 },
          }),
        ).http,
      ),
      Effect.map((account) => {
        expect(account).toMatchObject({
          id: "openrouter-main",
          driver: ProviderDriverKind.make("openrouter"),
          plan: "OpenRouter",
          usageLimits: {
            checkedAt,
            monetaryUsage: { usedUsd: 25, remainingUsd: 75, limitUsd: 100 },
          },
        });
        expect(account.usageLimits.windows).toEqual([expect.objectContaining({ usedPercent: 25 })]);
      }),
    ),
);

it.effect("maps a null limit to pay-as-you-go monetary usage with no invented windows", () =>
  readOpenRouterUsageAccount(input).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      fixture(() =>
        Response.json({ data: { label: "main", usage: 12.5, limit: null, limit_remaining: null } }),
      ).http,
    ),
    Effect.map((account) => {
      expect(account.usageLimits.monetaryUsage).toEqual({ usedUsd: 12.5 });
      expect(account.usageLimits.windows).toEqual([]);
      expect(account.usageLimits.unavailable).toBeUndefined();
    }),
  ),
);

it.effect("reports probeFailed on an unparseable response body instead of fabricating usage", () =>
  Effect.gen(function* () {
    const { requests, http } = fixture(
      () =>
        new Response('{ "data": ', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const account = yield* readOpenRouterUsageAccount(input).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

    expect(requests).toEqual(["https://openrouter.ai/api/v1/key"]);
    expect(account.usageLimits).toMatchObject({
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    });
    expect(account.usageLimits.monetaryUsage).toBeUndefined();
  }),
);

it.effect("reports probeFailed on a rejected key request without another retry", () =>
  Effect.gen(function* () {
    const { requests, http } = fixture(() => new Response(null, { status: 401 }));
    const account = yield* readOpenRouterUsageAccount(input).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

    expect(requests).toEqual(["https://openrouter.ai/api/v1/key"]);
    expect(account.usageLimits).toMatchObject({
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    });
  }),
);
