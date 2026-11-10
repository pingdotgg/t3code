import * as LocalFlagship from "@alchemy.run/cloudflare-runtime/core/bindings/flagship";
import type { AlchemyContext } from "alchemy/AlchemyContext";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import { dispatchByMode } from "../LocalGateway.ts";
import type { App } from "./App.ts";
import { localFlagshipStore } from "./Flag.ts";
import {
  type EvaluationContext,
  type EvaluationDetails,
  FlagshipError,
  ReadFlags,
  type ReadFlagsClient,
} from "./ReadFlags.ts";
import { type FlagshipAuth, makeHttpFlagshipClient } from "./ReadFlagsHttpClient.ts";

/**
 * Local implementation of the {@link ReadFlags} binding — evaluates Flagship
 * feature flags over the Cloudflare HTTP API (`GET .../flagship/apps/{appId}/evaluate`)
 * using the **current credentials** instead of a native Worker binding
 * ({@link ReadFlagsBinding}).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can read
 * flag values with the same `getBooleanValue`/`getStringValue`/… client you'd
 * use inside a Worker:
 *
 * @example Reading a flag from an Action
 * ```typescript
 * const CheckFlag = Alchemy.Action(
 *   "CheckFlag",
 *   Effect.gen(function* () {
 *     const flags = yield* Cloudflare.Flagship.ReadFlags(app);
 *     return Effect.fn(function* () {
 *       return yield* flags.getBooleanValue("new-checkout", false);
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Flagship.ReadFlagsLocal)),
 * );
 * ```
 *
 * The app id is resolved at apply time through the ambient {@link RuntimeContext}
 * (in an Action, that's the resolve context the engine provides around the
 * body), so `ReadFlags(app)` works even though the app is created in the same
 * deploy.
 *
 * Under `alchemy dev`, a locally-emulated app (a `dev:` app id) is evaluated
 * against the local Flagship simulator's definitions with the same rules a
 * dev Worker's binding applies, so the full evaluation context is honored.
 *
 * Limitations vs. the Worker binding for a live app: the HTTP evaluate
 * endpoint only accepts a single `targetingKey` (read from
 * `context.targetingKey`), so attribute-based targeting rules that key off
 * other context fields cannot be exercised. The `raw` runtime binding has no
 * HTTP equivalent and dies if used — see {@link makeHttpFlagshipClient}.
 */
export const ReadFlagsLocal = Layer.effect(
  ReadFlags,
  Effect.gen(function* () {
    // Capture the account resolver without authenticating — only the HTTP
    // branch evaluates it. Credentials are ambient during stack-eval (the
    // stack's providers layer); capture the full context so the evaluate op
    // runs with the current credentials — no `host.bind`, no minted token.
    const environment = yield* CloudflareEnvironment;
    const context = yield* Effect.context<Credentials | HttpClient.HttpClient>();
    // Local evaluation reads the simulator's files.
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path | AlchemyContext>();
    const auth: FlagshipAuth = {
      authorize: (eff) => eff.pipe(Effect.provideContext(context)),
      accountId: Effect.map(environment, (env) => env.accountId),
    };

    return Effect.fn(function* (app: App) {
      // Deferred accessor — resolves the appId against the tracker at apply
      // time (in an Action, that's the engine's resolve context).
      const appId = yield* app.appId;
      return dispatchByMode(appId, makeHttpFlagshipClient(auth, appId), (id) =>
        makeLocalFlagshipClient(id, platform),
      );
    });
  }),
);

/**
 * A client over the local Flagship simulator for a `dev:` app: evaluates the
 * app's flag definitions in-process with the same rules a dev Worker's
 * binding applies. `raw` cannot be satisfied — there is no native binding
 * outside a Worker — so it dies with guidance.
 */
const makeLocalFlagshipClient = (
  appId: string,
  platform: Context.Context<FileSystem.FileSystem | Path.Path | AlchemyContext>,
): ReadFlagsClient => {
  const details = <T>(
    flagKey: string,
    defaultValue: T,
    expectedType: LocalFlagship.FlagshipValueType | undefined,
    context: EvaluationContext | undefined,
  ) =>
    localFlagshipStore(appId).pipe(
      Effect.flatMap((store) =>
        LocalFlagship.evaluate(store, { flagKey, defaultValue, expectedType, context }),
      ),
      Effect.map((d) => d as EvaluationDetails<T>),
      Effect.mapError(
        (cause) => new FlagshipError({ message: "Local Flagship evaluation failed", cause }),
      ),
      Effect.provideContext(platform),
    );
  const value = <T>(
    flagKey: string,
    defaultValue: T,
    expectedType: LocalFlagship.FlagshipValueType | undefined,
    context: EvaluationContext | undefined,
  ) => Effect.map(details(flagKey, defaultValue, expectedType, context), (d) => d.value);

  return {
    raw: Effect.die(
      new FlagshipError({
        message:
          "A locally-emulated Flagship app has no native binding outside a Worker; use the evaluation methods.",
        cause: undefined,
      }),
    ),
    get: (flagKey, defaultValue, context) => value(flagKey, defaultValue, undefined, context),
    getBooleanValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, "boolean", context),
    getStringValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, "string", context),
    getNumberValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, "number", context),
    getObjectValue: (flagKey, defaultValue, context) =>
      value(flagKey, defaultValue, "object", context),
    getBooleanDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, "boolean", context),
    getStringDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, "string", context),
    getNumberDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, "number", context),
    getObjectDetails: (flagKey, defaultValue, context) =>
      details(flagKey, defaultValue, "object", context),
  };
};
