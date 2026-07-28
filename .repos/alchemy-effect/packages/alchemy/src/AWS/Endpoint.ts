import { Endpoint } from "@distilled.cloud/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export const of = (endpoint: string) =>
  Layer.succeed(Endpoint.Endpoint, Effect.succeed(endpoint));

/**
 * Derive a custom endpoint (if any) from the surrounding
 * {@link AWSEnvironment}. If the environment has no `endpoint` set, this
 * Layer is empty (the SDK uses its default endpoint resolver).
 */
export const fromEnvironment: Layer.Layer<never, never, AWSEnvironment> =
  Layer.effect(
    Endpoint.Endpoint,
    Effect.gen(function* () {
      return Effect.map(
        yield* AWSEnvironment,
        (env) => env.endpoint ?? undefined!,
      );
    }),
  );
