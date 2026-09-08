import {
  Credentials,
  CredentialsFromEnv,
  credentials,
  MachineIdentity,
} from "@distilled.cloud/fly-io";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import type { App } from "./App.ts";
import type { Secret } from "./Secret.ts";
import type { SecretKey } from "./SecretKey.ts";

/**
 * Shared scaffolding for the HTTP-backed Fly Secret bindings.
 *
 * Fly has no native Worker-style binding. This layer captures the ambient
 * org `FLY_API_TOKEN` during stack-eval (so Actions work in-process) and,
 * when the host is a {@link Machine} or {@link Service}, injects
 * `FLY_API_TOKEN`, `FLY_APP_NAME`, and `FLY_SECRET_${LogicalId}` into the
 * host env as Outputs. Runtime calls inside a deployed host read those
 * env vars via {@link CredentialsFromEnv}.
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
      const secretNameKey = `FLY_SECRET_${resource.LogicalId}`;
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return options.makeClient(
          auth,
          envName("FLY_APP_NAME"),
          envName(secretNameKey),
        );
      }

      const host = yield* Binding.Host;
      if (isFlyHost(host)) {
        // Pass Outputs through bind data so apply waits for the Secret
        // and evaluates the name after it exists. Resolving the name
        // here reads process.env on the laptop and drops the env var.
        // Use the org token, not an app deploy token — deploy tokens
        // cannot GetSecret / Encrypt (PetSem).
        const token = yield* orgToken(context);
        yield* host.bind`${resource}`({
          env: {
            FLY_API_TOKEN: token,
            FLY_APP_NAME: resource.appName,
            [secretNameKey]: resource.name,
          },
        });
      }

      return options.makeClient(
        auth,
        toNameEffect(
          yield* resource.appName as unknown as Effect.Effect<unknown>,
        ),
        toNameEffect(yield* resource.name as unknown as Effect.Effect<unknown>),
      );
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
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return options.makeClient(
          makeSecretAuth(context),
          envName("FLY_APP_NAME"),
        );
      }

      const host = yield* Binding.Host;
      if (isFlyHost(host)) {
        const token = yield* orgToken(context);
        yield* host.bind`${app}`({
          env: {
            FLY_API_TOKEN: token,
            FLY_APP_NAME: app.appName,
          },
        });
      }

      return options.makeClient(
        makeSecretAuth(context),
        toNameEffect(yield* app.appName as unknown as Effect.Effect<unknown>),
      );
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

/**
 * Read a required env var inside a deployed host. The binding writes it
 * during reconcile, so a missing value is a defect, not a recoverable
 * error — keep the client's error channel free of `ConfigError`.
 */
const envName = (key: string): Effect.Effect<string> =>
  Config.string(key).pipe(Effect.orDie);

const toNameEffect = (value: unknown): Effect.Effect<string> => {
  if (typeof value === "string") return Effect.succeed(value);
  if (Effect.isEffect(value)) {
    return value as Effect.Effect<string>;
  }
  return Effect.die(
    "Fly secret binding expected a resolved app or secret name",
  );
};

export const unwrapSecretValue = (
  value: Redacted.Redacted<string> | string,
): string => (Redacted.isRedacted(value) ? Redacted.value(value) : value);

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const orgToken = (
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
) =>
  Credentials.pipe(
    Effect.provideContext(ambient),
    Effect.flatMap((resolve) => resolve),
    Effect.map((cfg) => Redacted.value(cfg.apiKey)),
  );
