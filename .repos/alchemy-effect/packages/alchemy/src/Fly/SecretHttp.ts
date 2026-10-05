import {
  Credentials,
  CredentialsFromEnv,
  credentials,
  MachineIdentity,
} from "@distilled.cloud/fly-io";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { bindFlyApiToken } from "./Credentials.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { App } from "./App.ts";
import type { Secret } from "./Secret.ts";
import type { SecretKey } from "./SecretKey.ts";

/**
 * Shared scaffolding for the HTTP-backed Fly Secret bindings.
 *
 * Fly has no native Worker-style binding. This layer captures the ambient
 * org token during stack-eval (so Actions work in-process) and `yield*`s
 * it plus `appName` / secret `name` so RuntimeContext.set runs. Platform
 * copies those Outputs into host env; runtime `yield*` gets them back.
 * {@link CredentialsFromEnv} still reads `FLY_API_TOKEN` after that copy.
 *
 * NOT exported from `index.ts`.
 */
export type AppNamed = Secret | SecretKey;

export const makeHttpSecretBinding = <
  Target extends AppNamed,
  Client,
>(options: {
  makeClient: (
    auth: SecretAuth,
    appName: Effect.Effect<string>,
    secretName: Effect.Effect<string>,
  ) => Client;
  /**
   * PetSem encrypt/sign/decrypt/verify only work from a Machine over
   * `/.fly/api` (implicit machine identity). Org tokens return Forbidden.
   */
  kms?: boolean;
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth =
      options.kms === true ? makeKmsAuth(context) : makeSecretAuth(context);

    return Effect.fn(function* (resource: Target) {
      yield* bindFlyApiToken().pipe(Effect.provideContext(context));
      const appName = yield* resource.appName;
      const secretName = yield* resource.name;
      return options.makeClient(auth, appName, secretName);
    });
  });

/**
 * Same scaffolding as {@link makeHttpSecretBinding}, but the target is
 * an {@link App} (no secret name). Used by ListSecrets.
 */
export const makeHttpAppBinding = <Client>(options: {
  makeClient: (auth: SecretAuth, appName: Effect.Effect<string>) => Client;
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    return Effect.fn(function* (app: App) {
      yield* bindFlyApiToken().pipe(Effect.provideContext(context));
      const appName = yield* app.appName;
      return options.makeClient(makeSecretAuth(context), appName);
    });
  });

/**
 * Injectable auth for the Secret HTTP client builders. Supplies an
 * `authorize` that provides `Credentials` + `HttpClient` to a raw SDK op.
 */
export interface SecretAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}

/** Build auth that uses ambient stack creds, or env creds inside a host. */
export const makeSecretAuth = (
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
): SecretAuth => ({
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ): Effect.Effect<A, E, RuntimeContext> => {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return eff.pipe(
        Effect.provide(
          Layer.mergeAll(CredentialsFromEnv, FetchHttpClient.layer),
        ),
        Effect.timeout("8 seconds"),
      ) as Effect.Effect<A, E, RuntimeContext>;
    }
    return eff.pipe(Effect.provideContext(ambient)) as Effect.Effect<
      A,
      E,
      RuntimeContext
    >;
  },
});

const FLY_MACHINE_API_SOCKET = "/.fly/api";

/** Distilled machines client over `/.fly/api`. URL host is unused. */
const flyMachineApiHttp: Layer.Layer<HttpClient.HttpClient> =
  NodeHttpClient.layerNodeHttpNoAgent.pipe(
    Layer.provide(
      NodeHttpClient.layerAgentOptions({
        // @ts-expect-error Node Agent accepts unix socketPath; Https.AgentOptions omits it
        socketPath: FLY_MACHINE_API_SOCKET,
        keepAlive: false,
      }),
    ),
  );

/**
 * PetSem encrypt/sign/decrypt/verify from a Machine. Org API tokens are
 * Forbidden; the machine identity is the unix socket at `/.fly/api`.
 * {@link MachineIdentity} is the protocol signal (no Authorization,
 * Connection: close). GetSecret in the same process keeps Bearer.
 */
export const makeKmsAuth = (
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
): SecretAuth => ({
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ): Effect.Effect<A, E, RuntimeContext> => {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return Effect.scoped(
        eff.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(MachineIdentity, true),
              flyMachineApiHttp,
              credentials({
                apiKey: "unused",
                apiBaseUrl: "http://localhost/v1",
              }),
            ),
          ),
        ),
      ).pipe(Effect.timeout("8 seconds")) as Effect.Effect<
        A,
        E,
        RuntimeContext
      >;
    }
    return eff.pipe(Effect.provideContext(ambient)) as Effect.Effect<
      A,
      E,
      RuntimeContext
    >;
  },
});

export const unwrapSecretValue = (
  value: Redacted.Redacted<string> | string,
): string => (Redacted.isRedacted(value) ? Redacted.value(value) : value);
