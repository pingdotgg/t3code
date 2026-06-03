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

export interface RpcServerEnvironment {
  alchemyContext: AlchemyContext["Service"];
  profile: string | undefined;
  envFile: string | undefined;
  stack: {
    name: string;
    stage: string;
  };
}

export type RpcEnvironmentServices = Layer.Success<ReturnType<typeof layer>>;

export const layer = (environment: RpcServerEnvironment) =>
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

export const fromEnv = () =>
  Config.string(RPC_SERVER_ENVIRONMENT_KEY).pipe(
    Config.map(JSON.parse),
    Effect.map((environment) => layer(environment)),
    Layer.unwrap,
  );
