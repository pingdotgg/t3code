import { ConfigProvider } from "effect/ConfigProvider";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { AlchemyContext, AlchemyContextLive } from "./AlchemyContext.ts";
import { provideFreshArtifactStore } from "./Artifacts.ts";
import { CredentialsStoreLive } from "./Auth/Credentials.ts";
import { ProfileStoreLive } from "./Auth/Profile.ts";
import { type StackEffect, StateScope } from "./Stack.ts";
import { Stage } from "./Stage.ts";
import { loadConfigProvider } from "./Util/ConfigProvider.ts";
import { PlatformServices } from "./Util/PlatformServices.ts";

// TODO(unify stack builds): this is one of several ways to build a stack;
// the others are `Alchemist/Operations.ts` (`buildStack`,
// `buildWithoutProgram`) and the test harness's scratch stacks
// (`alchemy-test/src/Core.ts`). They differ in config (this one reloads `.env`
// and drops the caller's ConfigProvider), adopt/updateStateStore, and how
// the state-store lease is scoped. Migrate everything to `Alchemist.plan` /
// `Alchemist.apply`: give Alchemist this file's per-call lease scope
// (`StateScope`), reimplement `Deploy.deploy` / `Destroy.destroy` on it,
// move scratch stacks onto it, then delete this file.

// Deploy-time only: kept out of `Stack.ts` because every runtime imports the
// `Stack` tag, and this module's top-level platform layer (Node + Bun
// platforms, `ws`, profile and credential stores) survives tree-shaking.

const platform = Layer.mergeAll(
  PlatformServices,
  FetchHttpClient.layer,
  Layer.provide(ProfileStoreLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
);
// override alchemy state store, CLI/reporting, state, and Config
const alchemy = (overrides?: { dev?: boolean }) =>
  Layer.mergeAll(
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

export const evalStack = <S extends { services: Context.Context<any> }, B, StackErr, Err, Req>(
  effect: StackEffect<S, StackErr, Stage | AlchemyContext>,
  fn: (stack: S) => Effect.Effect<B, Err, Req>,
  options: {
    stage: string;
    dev?: boolean;
    /**
     * Optional caller-supplied scope. When provided, scoped resources
     * (e.g. the dev sidecar process) live until the caller closes this
     * scope instead of being torn down when `evalStack` resolves. Used
     * by the test harness so the sidecar survives across `beforeAll`,
     * tests, and `afterAll`. When omitted, behaves as before with a
     * private scope closed on completion. The state store never outlives
     * the call.
     */
    scope?: Scope.Scope;
  },
) => {
  const body = Effect.gen(function* () {
    const stack = yield* effect;
    const configProvider = yield* loadConfigProvider(Option.none());
    return yield* fn(stack).pipe(
      provideFreshArtifactStore,
      Effect.provide(
        Layer.succeedContext(stack.services).pipe(
          Layer.provideMerge(Layer.succeed(ConfigProvider, configProvider)),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.succeed(Stage, options.stage).pipe(
        Layer.provideMerge(Layer.provideMerge(alchemy({ dev: options.dev }), platform)),
      ),
    ),
  );

  const scope = options.scope;
  return scope === undefined
    ? Effect.scoped(body)
    : // The state store closes with this call and releases its lease, so
      // the next call on the same long-lived scope can take it.
      Effect.scopedWith((stateScope) =>
        Scope.provide(body.pipe(Effect.provideService(StateScope, stateScope)), scope),
      );
};
