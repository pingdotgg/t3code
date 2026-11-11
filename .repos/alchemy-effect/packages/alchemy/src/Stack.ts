import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import type { Digest } from "effect/crypto/Digest";
import type { SecureRandom } from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import type { ActionLike } from "./Action.ts";
import type { AlchemyContext } from "./AlchemyContext.ts";
import type { ArtifactStore } from "./Artifacts.ts";
import type { CredentialsStore } from "./Auth/Credentials.ts";
import type { ProfileStore } from "./Auth/Profile.ts";
import { AuthProvidersLive, type AuthProviders } from "./Auth/Registry.ts";
import type { Input, InputProps } from "./Input.ts";
// Type-only: with verbatimModuleSyntax a value import would survive emit and
// drag the terminal helpers (node:tty, Sigil's ansi helpers) into every unbundled
// child process that loads Stack.ts.
import type { Interaction } from "./Interaction.ts";
import * as Output from "./Output.ts";
import type { Provider, ProviderCollectionLike } from "./Provider.ts";
import type { ResourceBinding, ResourceLike } from "./Resource.ts";
import type { SecretsEntry, SecretsOption } from "./Secrets/Provider.ts";
import { StackContext } from "./StackContext.ts";
import { Stage } from "./Stage.ts";
import type { State } from "./State/State.ts";
import { stackConfigLayer } from "./Util/ConfigProvider.ts";
import { effectClass, taggedFunction } from "./Util/effect.ts";
import type { PlatformServices } from "./Util/PlatformServices.ts";

export type StackServices =
  | Stack
  | Stage
  | Scope.Scope
  | FileSystem
  | Digest
  | SecureRandom
  | Path
  | AlchemyContext
  | HttpClient
  | ChildProcessSpawner
  | AuthProviders
  | ProfileStore
  | ArtifactStore
  | CredentialsStore
  | Interaction;

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
  | Interaction
  | ProfileStore
  | CredentialsStore
  | ArtifactStore
  | State
  | Req
>;

export type Stack = Context.ServiceClass.Shape<"Stack", Omit<StackSpec, "output">>;

/**
 * Where a stack's configuration comes from: a ConfigProvider layer, or a
 * list of them applied in order, later ones overriding earlier ones.
 *
 * The process environment implicitly closes every list, so the shell
 * overrides every provider. List `Secrets.ProcessEnv()` yourself to rank it
 * elsewhere, or `Secrets.ProcessEnv({ disabled: true })` to leave it out.
 * Omitting `secrets` preserves the existing ConfigProvider and CLI dotenv behavior.
 *
 * ```ts
 * secrets: [
 *   Doppler.Secrets({ project: "app", config: "dev" }),
 *   Secrets.DotEnv(),
 *   Secrets.ProcessEnv(),
 * ]
 * ```
 */
export type SecretProviders = SecretsEntry | ReadonlyArray<SecretsEntry>;

/**
 * The `secrets` option: providers, or a callback that picks them from the
 * stage, so one stack can read `.env` locally and a secrets manager
 * elsewhere:
 *
 * ```ts
 * secrets: ({ stage }) =>
 *   stage === "dev"
 *     ? Secrets.DotEnv()
 *     : Doppler.Secrets({ project: "app", config: stage }),
 * ```
 */
export type StackSecrets = SecretsOption<SecretProviders>;

export interface StackProps<Req> {
  providers: Layer.Layer<Extract<Req, ProviderServices>, never, StackServices>;
  state: Layer.Layer<State, never, StackServices>;
  /** Opt in to secret providers. When omitted, existing configuration is preserved. */
  secrets?: StackSecrets;
}

/**
 * Runtime fields the Stack factory attaches to a configured stack effect.
 * Class-reference forms expose only `stackName` until `.make(...)`.
 */
export type ConfiguredStackMeta<Req = never> = {
  readonly stackName: string;
} & StackProps<Req>;

/**
 * What `Alchemy.Stack(...)` returns, and what an `alchemy.run.ts`
 * default-exports: the stack program, not yet run, with its providers,
 * state store, and secrets attached.
 */
export type ConfiguredStack<Output, Req> = Effect.Effect<CompiledStack<Output>, ConfigError> &
  ConfiguredStackMeta<Req>;

export const Stack: Context.ServiceClass<Stack, "Stack", Omit<StackSpec, "output">> & {
  make<A, Req>(
    stack: {
      Shape: A;
    },
    effect: Effect.Effect<NoInfer<A extends object ? InputProps<A> : Input<A>>, ConfigError, Req>,
  ): Effect.Effect<CompiledStack<A>, ConfigError>;
  <Self>(): {
    <A, Req>(
      stackName: string,
      options: StackProps<NoInfer<Req>>,
      eff: Effect.Effect<A, ConfigError, Req>,
    ): Effect.Effect<Self, ConfigError> & {
      new (_: never): A extends object ? A : {};
      readonly stackName: string;
      stage: {
        [stage: string]: Effect.Effect<Self>;
      };
    };
  };
  <Self, Shape, Stages extends string = string>(): {
    (stackName: string): Effect.Effect<Self> & {
      new (_: never): Output.ToOutput<Shape>;
      readonly stackName: string;
      make: <A, Req>(
        options: StackProps<NoInfer<Req>>,
        effect: Effect.Effect<A, ConfigError, Req>,
      ) => ConfiguredStack<A, NoInfer<Req>>;
      stage: {
        readonly [S in Stages]: Effect.Effect<Self>;
      };
    };
  };
  <A, Req extends StackServices | ProviderServices = never>(
    stackName: string,
    options: StackProps<NoInfer<Req>>,
    eff: Effect.Effect<A, ConfigError, Req>,
  ): ConfiguredStack<A, NoInfer<Req>>;
} = Object.assign(
  taggedFunction(
    StackContext,
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
              secrets: options?.secrets,
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
            secrets: options?.secrets,
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

export interface CompiledStack<Output = any, Services = any> extends StackSpec<Output> {
  services: Context.Context<Services>;
}

export const StackName = Stack.use((stack) => Effect.succeed(stack.name));

export interface MakeStackProps<ROut = never> {
  name: string;
  /** Required; {@link make} dies with setup guidance when it is missing. */
  providers?: Layer.Layer<ROut, never, StackServices>;
  /** Required; {@link make} dies with setup guidance when it is missing. */
  state?: Layer.Layer<State, never, StackServices>;
  /** Opt in to secret providers. When omitted, existing configuration is preserved. */
  secrets?: StackSecrets;
  /** @internal */
  stack?: StackSpec;
}

/**
 * The scope a stack's state store is built into when it must close sooner
 * than the rest of the stack. A store holds its stack's lease until its scope
 * closes, so `evalStack` (`EvalStack.ts`) gives it one per call even when the caller
 * keeps providers alive in a longer scope.
 */
export class StateScope extends Context.Service<StateScope, Scope.Scope>()(
  "alchemy/Stack/StateScope",
) {}

/**
 * Build a stack's providers, state store, secrets config and `Stack` spec,
 * without running its program. Destroy needs nothing more: it plans from state
 * alone, and every row records the provider mode that deletes it.
 */
export const build = <ROut = never>(options: MakeStackProps<ROut>) =>
  Effect.all([Effect.scope, Effect.serviceOption(StateScope)]).pipe(
    Effect.flatMap(([scope, stateScope]) => {
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
      const state = options.state;
      return options.providers.pipe(
        Layer.provideMerge(
          Option.match(stateScope, {
            onNone: () => state,
            onSome: (stateScope) => Layer.effectContext(Layer.buildWithScope(state, stateScope)),
          }),
        ),
        Layer.provideMerge(stackConfigLayer(options.secrets)),
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
        Layer.provideMerge(AuthProvidersLive),
        Layer.buildWithScope(scope),
      );
    }),
  );

/** Build a stack's services with {@link build}, then run its program under them. */
export const make =
  <ROut = never>(options: MakeStackProps<ROut>) =>
  <A, Err = never, Req extends ROut | StackServices = never>(effect: Effect.Effect<A, Err, Req>) =>
    build(options).pipe(
      Effect.flatMap((context) =>
        Effect.all([effect, Stack, Effect.context<ROut | StackServices>()]).pipe(
          Effect.map(([output, stack, services]): CompiledStack<A, ROut | StackServices> => ({
            ...stack,
            output,
            services: Context.merge(services, context),
          })),
          Effect.provideContext(context),
        ),
      ),
    );

/** What `Alchemy.Stack(...)` attaches to the stack it returns: everything but its program. */
export interface StackDefinition<ROut = never> {
  readonly stackName: string;
  readonly providers?: Layer.Layer<ROut, never, StackServices>;
  readonly state?: Layer.Layer<State, never, StackServices>;
  readonly secrets?: StackSecrets;
}

export const CurrentStack = Effect.serviceOption(Stack)

  .pipe(Effect.map(Option.getOrUndefined));
