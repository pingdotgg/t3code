import {
  Credentials,
  fromApiToken,
} from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * Resolve credentials from a bound token's value and provide them (plus the
 * fetch-based HTTP client) to a raw SDK operation.
 */
export const authorizeWith =
  (token: { value: Effect.Effect<Redacted.Redacted<string>> }) =>
  <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient>,
  ): Effect.Effect<A, E, RuntimeContext> =>
    token.value.pipe(
      Effect.flatMap((value) =>
        eff.pipe(
          Effect.provide(
            fromApiToken({ apiToken: Redacted.value(value) }).pipe(
              Layer.provideMerge(FetchHttpClient.layer),
            ),
          ),
        ),
      ),
    );
