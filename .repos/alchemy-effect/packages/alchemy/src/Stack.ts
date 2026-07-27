import type { ConfigError } from "effect/Config";
import { ConfigProvider } from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { ActionLike } from "./Action.ts";
import { AlchemyContext, AlchemyContextLive } from "./AlchemyContext.ts";
import { type ArtifactStore, provideFreshArtifactStore } from "./Artifacts.ts";
import { AuthProviders } from "./Auth/AuthProvider.ts";
import { CredentialsStore, CredentialsStoreLive } from "./Auth/Credentials.ts";
import { AlchemyProfile, ProfileLive } from "./Auth/Profile.ts";
import { Cli } from "./Cli/Cli.ts";
import type { Input, InputProps } from "./Input.ts";
import * as Output from "./Output.ts";
import type { Provider, ProviderCollectionLike } from "./Provider.ts";
import type { ResourceBinding, ResourceLike } from "./Resource.ts";
import { Stage } from "./Stage.ts";
import type { State } from "./State/State.ts";
import { loadConfigProvider } from "./Util/ConfigProvider.ts";
import { effectClass, taggedFunction } from "./Util/effect.ts";
import { fileLogger } from "./Util/FileLogger.ts";
import { PlatformServices } from "./Util/PlatformServices.ts";

export type StackServices =
  | Stack
  | Stage
  | Scope.Scope
  | FileSystem
  | Path
  | AlchemyContext
  | HttpClient
  | ChildProcessSpawner
  | AuthProviders
  | AlchemyProfile
  | ArtifactStore
  | CredentialsStore
  | Cli;

export type ProviderServices =
  | ProviderCollectionLike
  | Provider<any>
  | EnvironmentLike
  | CredentialsLike
  | DockerLike;

// tagged type to allow types like AWSEnvironment/AWS Region to bubble through
export interface EnvironmentLike {
  readonly kind: "Environment";
}

// tagged type to allow types like AWS Credentials to bubble through
export interface CredentialsLike {
  readonly kind: "Credentials";
}

export interface DockerLike {
  readonly key: "@alchemy/Docker";
}

export type StackEffect<A, Err = never, Req = never> = Effect.Effect<
  A,
  Err,
  | PlatformServices
  | HttpClient
  | Scope.Scope
  | AuthProviders
  | AlchemyContext
  | Cli
  | AlchemyProfile
  | CredentialsStore
  | ArtifactStore
  | State
  | Req
>;

export type Stack = Context.ServiceClass.Shape<
  "Stack",
  Omit<StackSpec, "output">
>;

export interface StackProps<Req> {
  providers: Layer.Layer<Extract<Req, ProviderServices>, never, StackServices>;
  state: Layer.Layer<State, never, StackServices>;
}

export const Stack: Context.ServiceClass<
  Stack,
  "Stack",
  Omit<StackSpec, "output">
> & {
  make<A, Req>(
    stack: {
      Shape: A;
    },
    effect: Effect.Effect<
      NoInfer<A extends object ? InputProps<A> : Input<A>>,
      ConfigError,
      Req
    >,
  ): Effect.Effect<CompiledStack<A>, ConfigError>;
  <Self>(): {
    <A, Req>(
      stackName: string,
      options: StackProps<NoInfer<Req>>,
      eff: Effect.Effect<A, ConfigError, Req>,
    ): Effect.Effect<Self, ConfigError> & {
      new (_: never): A extends object ? A : {};
      stage: {
        [stage: string]: Effect.Effect<Self>;
      };
    };
  };
  <Self, Shape>(): {
    (stackName: string): Effect.Effect<Self> & {
      new (_: never): Output.ToOutput<Shape>;
      make: <A, Req>(
        options: StackProps<NoInfer<Req>>,
        effect: Effect.Effect<A, ConfigError, Req>,
      ) => Effect.Effect<CompiledStack<A>, ConfigError>;
      stage: {
        [stage: string]: Effect.Effect<Self>;
      };
    };
  };
  <A, Req extends StackServices | ProviderServices = never>(
    stackName: string,
    options: StackProps<NoInfer<Req>>,
    eff: Effect.Effect<A, ConfigError, Req>,
  ): Effect.Effect<CompiledStack<A>, ConfigError>;
} = Object.assign(
  taggedFunction(
    Context.Service<Stack, Omit<StackSpec, "output">>()("Stack"),
    <A, Req>(
      stackName?: string,
      options?: StackProps<NoInfer<Req>>,
      eff?: Effect.Effect<A, ConfigError, Req>,
    ) => {
      if (!stackName) {
        return (stackName: string) =>
          Object.assign(
            // by default, reference the stack at the "current" stage of the importer
            Output.stackRef<A>(stackName).pipe(effectClass),
            {
              stackName,
              stage: createStageProxy(stackName),
              state: options?.state,
              providers: options?.providers,
              make: <Req = never>(
                options: StackProps<NoInfer<Req>>,
                eff: Effect.Effect<A, ConfigError, Req>,
              ) =>
                // @ts-expect-error
                Stack(stackName, options, eff),
            },
          );
      }
      return eff!.pipe(
        // @ts-expect-error
        make({
          name: stackName,
          ...options!,
        }),
        (eff) =>
          Object.assign(eff, {
            stackName,
            stage: createStageProxy(stackName),
            state: options?.state,
            providers: options?.providers,
          }),
      );
    },
  ),
) as any;

const createStageProxy = (stackName: string) =>
  new Proxy(
    {},
    {
      get: (_, stage: string) => Output.stackRef(stackName, { stage }),
    },
  );

export interface StackSpec<Output = any> {
  name: string;
  stage: string;
  // @internal
  resources: {
    [logicalId: string]: ResourceLike;
  };
  bindings: {
    [logicalId: string]: ResourceBinding[];
  };
  /** Tasks registered on the stack, keyed by FQN. */
  actions: {
    [logicalId: string]: ActionLike;
  };
  output: Output;
}

export interface CompiledStack<
  Output = any,
  Services = any,
> extends StackSpec<Output> {
  services: Context.Context<Services>;
}

export const StackName = Stack.use((stack) => Effect.succeed(stack.name));

export interface MakeStackProps<ROut = never> {
  name: string;
  providers: Layer.Layer<ROut, never, StackServices>;
  state: Layer.Layer<State, never, StackServices>;
  /** @internal */
  stack?: StackSpec;
}

export const make =
  <ROut = never>(options: MakeStackProps<ROut>) =>
  <A, Err = never, Req extends ROut | StackServices = never>(
    effect: Effect.Effect<A, Err, Req>,
  ) =>
    Effect.scope.pipe(
      Effect.flatMap((scope) => {
        if (options.state == null) {
          return Effect.die(
            new Error(
              `Stack "${options.name}" is missing a state store. ` +
                `Add a \`state\` layer to the stack options, e.g.:\n` +
                `  Alchemy.Stack("${options.name}", {\n` +
                `    providers: Cloudflare.providers(),\n` +
                `    state: Cloudflare.state(), // <-- required\n` +
                `  }, ...)\n` +
                `See https://alchemy.run/state-store for available state stores.`,
            ),
          );
        }
        if (options.providers == null) {
          return Effect.die(
            new Error(
              `Stack "${options.name}" is missing a providers layer. ` +
                `Add a \`providers\` layer to the stack options, e.g.:\n` +
                `  Alchemy.Stack("${options.name}", {\n` +
                `    providers: Cloudflare.providers(), // <-- required\n` +
                `    state: Cloudflare.state(),\n` +
                `  }, ...)`,
            ),
          );
        }
        return options.providers.pipe(
          Layer.provideMerge(options.state),
          Layer.provideMerge(
            Layer.effect(
              Stack,
              Stage.pipe(
                Effect.map(
                  (stage) =>
                    options.stack ?? {
                      name: options.name,
                      stage,
                      resources: {},
                      bindings: {},
                      actions: {},
                    },
                ),
              ),
            ),
          ),
          Layer.buildWithScope(scope),
        );
      }),
      Effect.flatMap((context) =>
        Effect.all([
          effect,
          Stack,
          Effect.context<ROut | StackServices>(),
        ]).pipe(
          Effect.map(
            ([output, stack, services]): CompiledStack<
              A,
              ROut | StackServices
            > => ({
              ...stack,
              output,
              services: Context.merge(services, context),
            }),
          ),
          Effect.provideContext(context),
        ),
      ),
    );

export const CurrentStack = Effect.serviceOption(Stack)

  .pipe(Effect.map(Option.getOrUndefined));

const platform = Layer.mergeAll(
  PlatformServices,
  FetchHttpClient.layer,
  Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
);
// override alchemy state store, CLI/reporting, state, and Config
const alchemy = (overrides?: { dev?: boolean }) =>
  Layer.mergeAll(
    // CLI.inkCLI(),
    // optional
    overrides?.dev
      ? Layer.provide(
          Layer.effect(
            AlchemyContext,
            AlchemyContext.useSync((ctx) => ({ ...ctx, dev: overrides.dev! })),
          ),
          AlchemyContextLive,
        )
      : AlchemyContextLive,
  );

export const evalStack = <A, B, StackErr, Err, Req>(
  effect: StackEffect<CompiledStack<A>, StackErr, Stage | AlchemyContext>,
  fn: (stack: CompiledStack<A>) => Effect.Effect<B, Err, Req>,
  options: {
    stage: string;
    dev?: boolean;
    /**
     * Optional caller-supplied scope. When provided, scoped resources
     * (e.g. the dev sidecar process) live until the caller closes this
     * scope instead of being torn down when `evalStack` resolves. Used
     * by the test harness so the sidecar survives across `beforeAll`,
     * tests, and `afterAll`. When omitted, behaves as before with a
     * private scope closed on completion.
     */
    scope?: Scope.Scope;
  },
) => {
  const body = Effect.gen(function* () {
    const stack = yield* effect;
    const configProvider = yield* loadConfigProvider(Option.none());

    return yield* fn(stack).pipe(
      provideFreshArtifactStore,
      Effect.provide(stack.services),
      Effect.provide(Layer.succeed(ConfigProvider, configProvider)),
    );
  }).pipe(
    Effect.provide(
      Layer.effect(
        AuthProviders,
        Effect.serviceOption(AuthProviders).pipe(
          Effect.map(Option.getOrElse(() => ({}))),
        ),
      ).pipe(
        Layer.provideMerge(Layer.succeed(Stage, options.stage)),
        Layer.provideMerge(
          Layer.provideMerge(alchemy({ dev: options.dev }), platform),
        ),
      ),
    ),
  );

  return options.scope === undefined
    ? Effect.scoped(body)
    : Scope.provide(body, options.scope);
};
