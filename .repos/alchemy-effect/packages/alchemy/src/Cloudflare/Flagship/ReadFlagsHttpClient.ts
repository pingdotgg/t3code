import type * as cf from "@cloudflare/workers-types";
import * as flagship from "@distilled.cloud/cloudflare/flagship";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Credentials } from "../Credentials.ts";
import {
  type EvaluationContext,
  type EvaluationDetails,
  FlagshipError,
  type ReadFlagsClient,
} from "./ReadFlags.ts";

// Shared HTTP scaffolding for the Flagship `ReadFlags` binding. NOT
// re-exported from `index.ts` — only the contract and the impl layers are
// public. A future token-scoped `ReadFlagsHttp` layer reuses this builder with
// an auth minted from an `AccountApiToken`; `ReadFlagsLocal` builds the auth
// from the ambient current-credentials context.

/**
 * Injectable auth shared by the Local (current-credentials) impl and a future
 * Http (scoped-token) impl. `authorize` discharges the
 * `Credentials | HttpClient` requirement of a distilled op; `accountId` is the
 * Cloudflare account the ops run against.
 */
export interface FlagshipAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E>;
  accountId: string;
}

/**
 * The HTTP evaluate endpoint only supports a single `targetingKey` query
 * param, not the full flat evaluation context the Worker binding accepts.
 */
const targetingKeyOf = (
  context: EvaluationContext | undefined,
): string | undefined => {
  const value = context?.["targetingKey"];
  return value === undefined ? undefined : String(value);
};

/**
 * Build a {@link ReadFlagsClient} over the Flagship HTTP evaluate endpoint
 * (`GET .../flagship/apps/{appId}/evaluate`).
 *
 * `appId` is an Effect so the resolution stays deferred to each call — inside
 * an Action it resolves through the apply-time RuntimeContext. Mirrors the
 * Worker binding's fall-back-to-default semantics: evaluation never fails the
 * effect — an HTTP error or a value whose type does not match the requested
 * method resolves to `defaultValue` instead. The `raw` runtime binding has no
 * HTTP equivalent and dies if used.
 */
export const makeHttpFlagshipClient = (
  auth: FlagshipAuth,
  appId: Effect.Effect<string>,
): ReadFlagsClient => {
  const evaluate = (flagKey: string, context?: EvaluationContext) =>
    appId.pipe(
      Effect.flatMap((id) =>
        auth.authorize(
          flagship.getAppEvaluate({
            accountId: auth.accountId,
            appId: id,
            flagKey,
            targetingKey: targetingKeyOf(context),
          }),
        ),
      ),
    );

  const details = <T>(
    flagKey: string,
    defaultValue: T,
    match: (value: unknown) => value is T,
    context?: EvaluationContext,
  ): Effect.Effect<EvaluationDetails<T>, FlagshipError, RuntimeContext> =>
    evaluate(flagKey, context).pipe(
      Effect.map(
        (r): EvaluationDetails<T> =>
          match(r.value)
            ? { flagKey, value: r.value, variant: r.variant, reason: r.reason }
            : {
                flagKey,
                value: defaultValue,
                variant: r.variant,
                reason: r.reason,
                errorCode: "TYPE_MISMATCH",
              },
      ),
      Effect.catch((error) =>
        Effect.succeed<EvaluationDetails<T>>({
          flagKey,
          value: defaultValue,
          reason: "ERROR",
          errorCode: error._tag,
        }),
      ),
    );

  const value = <T>(
    flagKey: string,
    defaultValue: T,
    match: (value: unknown) => value is T,
    context?: EvaluationContext,
  ): Effect.Effect<T, FlagshipError, RuntimeContext> =>
    evaluate(flagKey, context).pipe(
      Effect.map((r) => (match(r.value) ? r.value : defaultValue)),
      Effect.catch(() => Effect.succeed(defaultValue)),
    );

  const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
  const isString = (v: unknown): v is string => typeof v === "string";
  const isNumber = (v: unknown): v is number => typeof v === "number";
  const isObjectLike = (v: unknown): boolean =>
    v !== null && typeof v === "object";

  return {
    // The raw runtime binding is a workerd object with no HTTP surface.
    raw: Effect.die(
      new FlagshipError({
        message:
          "the raw Flagship runtime binding is unavailable over HTTP; use ReadFlagsBinding inside a Worker",
        cause: undefined,
      }),
    ) as Effect.Effect<cf.Flagship, never, RuntimeContext>,
    get: (flagKey, defaultValue, context) =>
      evaluate(flagKey, context).pipe(
        Effect.map((r) => r.value ?? defaultValue),
        Effect.catch(() => Effect.succeed(defaultValue)),
      ),
    getBooleanValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, isBoolean, context),
    getStringValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, isString, context),
    getNumberValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, isNumber, context),
    getObjectValue: (flagKey, defaultValue, context) =>
      evaluate(flagKey, context).pipe(
        Effect.map((r) =>
          isObjectLike(r.value)
            ? (r.value as typeof defaultValue)
            : defaultValue,
        ),
        Effect.catch(() => Effect.succeed(defaultValue)),
      ),
    getBooleanDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, isBoolean, context),
    getStringDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, isString, context),
    getNumberDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, isNumber, context),
    getObjectDetails: (flagKey, defaultValue, context) =>
      evaluate(flagKey, context).pipe(
        Effect.map(
          (r): EvaluationDetails<typeof defaultValue> =>
            isObjectLike(r.value)
              ? {
                  flagKey,
                  value: r.value as typeof defaultValue,
                  variant: r.variant,
                  reason: r.reason,
                }
              : {
                  flagKey,
                  value: defaultValue,
                  variant: r.variant,
                  reason: r.reason,
                  errorCode: "TYPE_MISMATCH",
                },
        ),
        Effect.catch((error) =>
          Effect.succeed<EvaluationDetails<typeof defaultValue>>({
            flagKey,
            value: defaultValue,
            reason: "ERROR",
            errorCode: error._tag,
          }),
        ),
      ),
  } satisfies ReadFlagsClient;
};
