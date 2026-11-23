import {
  MarginStatsPayload,
  type MarginStatsInput,
  type MarginStatsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { customClaudeApiEndpointHost } from "../provider/Drivers/ClaudeSkills.ts";

const REQUEST_TIMEOUT_MS = 2_500;
const decodeMarginStatsPayload = Schema.decodeUnknownEffect(MarginStatsPayload);

export class MarginStatsService extends Context.Service<
  MarginStatsService,
  {
    readonly readStats: (input: MarginStatsInput) => Effect.Effect<MarginStatsResult>;
  }
>()("t3/usage/MarginStatsService") {}

function resolveMarginEndpoint(rawBaseUrl: string | undefined): string | undefined {
  if (customClaudeApiEndpointHost(rawBaseUrl) === undefined) return undefined;
  const parsed = URL.parse(rawBaseUrl?.trim() ?? "");
  return parsed?.origin;
}

export function makeMarginStatsService(options?: {
  readonly getBaseUrl?: () => string | undefined;
}): MarginStatsService["Service"] {
  const getBaseUrl = options?.getBaseUrl ?? (() => process.env.ANTHROPIC_BASE_URL);

  const readStats = Effect.fn("MarginStatsService.readStats")(function* (input: MarginStatsInput) {
    const endpoint = resolveMarginEndpoint(getBaseUrl());
    if (!endpoint) {
      return { status: "unconfigured" } satisfies MarginStatsResult;
    }

    const url = new URL("/stats", endpoint);
    if (input.since && input.since.trim().length > 0) {
      url.searchParams.set("since", input.since.trim());
    }

    const response = yield* Effect.tryPromise({
      try: () => globalThis.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false as const,
          networkError: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    );

    if ("networkError" in response) {
      return {
        status: "unavailable",
        endpoint,
        message: response.networkError,
      } satisfies MarginStatsResult;
    }

    if (!response.ok) {
      if (response.status === 404 || response.status === 405) {
        return { status: "unconfigured" } satisfies MarginStatsResult;
      }
      return {
        status: "unavailable",
        endpoint,
        message: `HTTP ${response.status}`,
      } satisfies MarginStatsResult;
    }

    const rawJson = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => null,
    }).pipe(Effect.catch(() => Effect.succeed(null)));

    if (rawJson === null) {
      return { status: "unconfigured" } satisfies MarginStatsResult;
    }

    const parsed = yield* decodeMarginStatsPayload(rawJson).pipe(
      Effect.map((stats) => ({ status: "ready", endpoint, stats }) satisfies MarginStatsResult),
      Effect.catch(() => Effect.succeed({ status: "unconfigured" } satisfies MarginStatsResult)),
    );

    return parsed;
  });

  return MarginStatsService.of({ readStats });
}

export const layer = Layer.sync(MarginStatsService, () => makeMarginStatsService());
