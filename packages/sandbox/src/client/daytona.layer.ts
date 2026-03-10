import { loadEnv } from "@repo/config/env";
import { Daytona, type DaytonaConfig } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type CreateDaytonaClientError,
  DaytonaClientInitializationError,
  MissingDaytonaApiKeyError,
} from "./daytona.errors";
import {
  DaytonaClient,
  type DaytonaClientLayerOptions,
  type DaytonaClientShape,
} from "./daytona.client";

function requireDaytonaApiKey(
  value: string | undefined,
): Effect.Effect<string, MissingDaytonaApiKeyError> {
  if (!value) {
    return Effect.fail(
      new MissingDaytonaApiKeyError({
        message: "DAYTONA_API_KEY is required to use the Daytona sandbox client.",
      }),
    );
  }

  return Effect.succeed(value);
}

function buildDaytonaConfig(
  options: DaytonaClientLayerOptions,
): Effect.Effect<DaytonaConfig, CreateDaytonaClientError> {
  return Effect.gen(function* () {
    const env = yield* loadEnv();
    const apiKey = yield* requireDaytonaApiKey(options.apiKey ?? env.DAYTONA_API_KEY);

    return {
      apiKey,
      apiUrl: options.apiUrl ?? env.DAYTONA_API_URL,
      target: options.target ?? env.DAYTONA_TARGET,
    };
  });
}

export function makeDaytonaClient(
  options: DaytonaClientLayerOptions = {},
): Effect.Effect<DaytonaClientShape, CreateDaytonaClientError> {
  return Effect.gen(function* () {
    const config = yield* buildDaytonaConfig(options);
    const client = yield* Effect.try({
      try: () => new Daytona(config),
      catch: (cause) =>
        new DaytonaClientInitializationError({
          message: "Failed to initialize the Daytona client.",
          cause,
        }),
    });

    return {
      client,
    } satisfies DaytonaClientShape;
  });
}

export function makeDaytonaClientLayer(options: DaytonaClientLayerOptions = {}) {
  return Layer.effect(DaytonaClient, makeDaytonaClient(options));
}

export const createDaytonaClient = makeDaytonaClient;
export const DaytonaClientLive = makeDaytonaClientLayer;
