import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AlchemyContext } from "../AlchemyContext.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive, withProfileOverride } from "../Auth/Profile.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";

/**
 * The stack-specific half of the sidecar environment. One sidecar process
 * serves many stacks (the test harness shares a single child across all
 * test files), so this part travels per RPC session — as a query parameter
 * on the session websocket — rather than being baked into the child's env
 * at spawn time.
 */
export interface SessionEnvironment {
  alchemyContext: AlchemyContext["Service"];
  stack: {
    name: string;
    stage: string;
  };
}

export interface RpcServerEnvironment {
  profile: string | undefined;
  envFile: string | undefined;
  /**
   * Default session environment for sessions that do not carry their own
   * (legacy single-stack boots). Sessions created by {@link RpcProviderProxy}
   * always send an explicit {@link SessionEnvironment}.
   */
  alchemyContext?: AlchemyContext["Service"];
  stack?: {
    name: string;
    stage: string;
  };
}

/** Query parameter carrying the JSON {@link SessionEnvironment} on session websockets. */
export const SESSION_ENV_PARAM = "alchemy-session-env";

export const encodeSessionEnvironment = (env: SessionEnvironment): string =>
  JSON.stringify(env);

export const decodeSessionEnvironment = (raw: string): SessionEnvironment =>
  JSON.parse(raw) as SessionEnvironment;

export type RpcEnvironmentServices = Layer.Success<ReturnType<typeof layer>>;

export const layer = (
  environment: Pick<RpcServerEnvironment, "profile" | "envFile"> &
    SessionEnvironment,
) =>
  Layer.mergeAll(
    ProfileLive,
    CredentialsStoreLive,
    Layer.succeed(AuthProviders, {}),
    ConfigProvider.layer(
      loadConfigProvider(Option.fromNullishOr(environment.envFile)).pipe(
        Effect.map((base) => withProfileOverride(base, environment.profile)),
      ),
    ),
    Layer.succeed(AlchemyContext, environment.alchemyContext),
    Layer.succeed(Stack, {
      name: environment.stack.name,
      stage: environment.stack.stage,
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, environment.stack.stage),
  );

export const RPC_SERVER_ENVIRONMENT_KEY =
  "ALCHEMY_RPC_SERVER_ENVIRONMENT" as const;

/** The spawn-time environment the parent baked into the child's process env. */
export const fromProcessEnv: Effect.Effect<RpcServerEnvironment, unknown> =
  Config.string(RPC_SERVER_ENVIRONMENT_KEY).pipe(
    Config.map((raw) => JSON.parse(raw) as RpcServerEnvironment),
  );

/**
 * Legacy single-stack boot: the full environment (including the stack) baked
 * into the process env at spawn time. Used by children that serve exactly one
 * stack for their whole lifetime (e.g. the Vite dev-server child, which gets
 * an explicit environment from `startViteChild`). RPC sidecars do NOT use
 * this — their sessions each carry a {@link SessionEnvironment}.
 */
export const fromEnv = () =>
  Layer.unwrap(
    fromProcessEnv.pipe(
      Effect.flatMap(
        (
          environment,
        ): Effect.Effect<ReturnType<typeof layer>, unknown, never> =>
          environment.stack === undefined ||
          environment.alchemyContext === undefined
            ? Effect.die(
                new Error(
                  `${RPC_SERVER_ENVIRONMENT_KEY} carries no stack/alchemyContext — this child requires the legacy single-stack environment`,
                ),
              )
            : Effect.succeed(
                layer({
                  profile: environment.profile,
                  envFile: environment.envFile,
                  stack: environment.stack,
                  alchemyContext: environment.alchemyContext,
                }),
              ),
      ),
    ),
  );
