/**
 * The core of the Alchemist operations: the builds they choose from (with
 * or without the stack's program, or providers only), and the stack
 * {@link plan} → {@link apply} pair deploys and destroys share. Drift and
 * nuke have their own namespaces.
 */
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { CurrentLogAnnotations, CurrentLogSpans, MinimumLogLevel } from "effect/References";
import * as Tracer from "effect/Tracer";
import { AdoptPolicy } from "../AdoptPolicy.ts";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Apply from "../Apply.ts";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { withProfileOverride } from "../Auth/Resolve.ts";
import { emit, type PlannedAction, type PlannedResource } from "../Events.ts";
import * as Plan from "../Plan.ts";
import type { ResourceSelection, SelectionOutput } from "../ResourceSelection.ts";
import * as Stack from "../Stack.ts";
import { Stage } from "../Stage.ts";
import type { State } from "../State/State.ts";
import { loadConfigProvider, StackConfigOverrides } from "../Util/ConfigProvider.ts";

/** Which credentials and config a stack build sees. */
export interface ConfigOptions {
  /** `.env` file layered under the process environment. */
  readonly envFile?: string;
  /** Profile whose credentials the run uses. Falls back to the active profile. */
  readonly profile?: string;
}

export interface BuildOptions extends ConfigOptions {
  readonly stage: string;
  /** Run local (emulated) providers instead of the real cloud. */
  readonly dev?: boolean;
  /** Adopt pre-existing cloud resources instead of failing on conflict. */
  readonly adopt?: boolean;
  /** Upgrade an out-of-date state store without prompting. */
  readonly updateStateStore?: boolean;
}

/** Config services shared by every stack build. */
export const configServices = Effect.fn("Alchemist.configServices")(function* (
  options: ConfigOptions,
) {
  const envFile = Option.fromNullishOr(options.envFile);
  const commandConfig = yield* loadConfigProvider(envFile);
  // `envFile` only steers a stack's default secrets list and `profile`
  // pins the profile inside it; see stackConfigLayer.
  return Layer.mergeAll(
    Layer.succeed(StackConfigOverrides, {
      envFile: options.envFile,
      profile: options.profile,
    }),
    ConfigProvider.layer(withProfileOverride(commandConfig, options.profile)),
  );
});

// TODO(unify stack builds): the one stack build everything should use; see
// the TODO in `EvalStack.ts` for the other paths still to migrate here.

/** The per-build services a stack's providers and program run under. */
const buildServices = Effect.fn("Alchemist.buildServices")(function* (options: BuildOptions) {
  yield* emit({ type: "plan.phase", phase: "resolving-services" });
  return yield* Layer.build(
    Layer.mergeAll(
      Layer.effect(
        AlchemyContext,
        Effect.map(AlchemyContext, (context) => ({
          ...context,
          dev: options.dev ?? context.dev,
          adopt: options.adopt ?? false,
          updateStateStore: options.updateStateStore ?? false,
        })),
      ),
      Layer.succeedContext(
        Context.make(AdoptPolicy, options.adopt ?? false).pipe(
          Context.add(ArtifactStore, createArtifactStore()),
          Context.add(Stage, options.stage),
        ),
      ),
      yield* configServices(options),
    ),
  );
});

/**
 * The building fiber's logging and tracing, dropped from a built context:
 * a plan or scan is applied later, and possibly under other loggers (an
 * `onEvent` subscriber around `apply`), which providing the captured ones
 * would silently replace.
 */
const withoutFiberLogging = Context.omit(
  Logger.CurrentLoggers,
  MinimumLogLevel,
  CurrentLogAnnotations,
  CurrentLogSpans,
  Tracer.ParentSpan,
);

/**
 * Build a stack's providers and state store and run its program.
 *
 * @internal used by {@link plan} and `Logs`.
 */
export const buildStack = Effect.fn("Alchemist.build")(function* <Output, Req>(
  stack: Stack.ConfiguredStack<Output, Req>,
  options: BuildOptions,
) {
  const baseContext = yield* buildServices(options);
  const compiled = yield* Effect.provide(stack, baseContext);
  return {
    stack: compiled,
    /** The stack's own providers and state store over the build's services. */
    context: withoutFiberLogging(Context.merge(baseContext, compiled.services)),
  };
});

/**
 * Build a stack's providers and state store without running its program:
 * all that destroy, drift, and state access need, and safe when the
 * program itself no longer runs.
 *
 * @internal used by {@link plan}, `Drift.scan`, and `State.store`.
 */
export const buildWithoutProgram = Effect.fn("Alchemist.buildWithoutProgram")(function* <Req>(
  stack: Stack.ConfiguredStack<unknown, Req>,
  options: BuildOptions,
) {
  const baseContext = yield* buildServices(options);
  const stackServices = yield* Effect.provide(
    Stack.build({
      name: stack.stackName,
      providers: stack.providers,
      state: stack.state,
      secrets: stack.secrets,
    }),
    baseContext,
  );
  return {
    stack: { ...Context.get(stackServices, Stack.Stack), output: undefined },
    context: withoutFiberLogging(Context.merge(baseContext, stackServices)),
  };
});

export interface PlanSummary {
  readonly create: number;
  readonly update: number;
  readonly adopted: number;
  readonly replace: number;
  readonly delete: number;
  readonly orphaned: number;
  /** Actions that will run. */
  readonly run: number;
  readonly noop: number;
}

/** Whether a plan or drift scan proposes any cloud mutations (i.e. approval-worthy work). */
export const hasChanges = ({ summary }: { readonly summary: PlanSummary }): boolean =>
  summary.create +
    summary.update +
    summary.adopted +
    summary.replace +
    summary.delete +
    summary.orphaned +
    summary.run >
  0;

export const summarize = (plan: Plan.Plan): PlanSummary => {
  const summary: { -readonly [K in keyof PlanSummary]: PlanSummary[K] } = {
    create: 0,
    update: 0,
    adopted: 0,
    replace: 0,
    delete: 0,
    orphaned: 0,
    run: 0,
    noop: 0,
  };
  for (const node of Object.values(plan.resources)) summary[node.action]++;
  for (const node of Object.values(plan.actions)) summary[node.action]++;
  for (const node of [...Object.values(plan.deletions), ...Object.values(plan.actionDeletions)]) {
    if (node !== undefined) summary[node.action]++;
  }
  return summary;
};

/** The services a stack plan is applied under. */
type StackContext = Context.Context<State | Stack.Stack | Stage>;

/**
 * A deploy or destroy plan: what will change, and the built stack it was
 * planned against so {@link apply} runs without rebuilding.
 */
export interface StackPlan<Output = unknown> {
  readonly stack: { readonly name: string; readonly stage: string };
  readonly summary: PlanSummary;
  /** Serializable resource rows (including orphan deletions). */
  readonly resources: ReadonlyArray<PlannedResource>;
  /** Serializable stack-action rows. */
  readonly actions: ReadonlyArray<PlannedAction>;
  /**
   * The engine plan `apply` executes, for renderers.
   * @internal its shape may change.
   */
  readonly native: Plan.Plan<Output>;
  /**
   * The stack services the plan was computed under; they live in the caller's `Scope`.
   * @internal `apply` runs in them.
   */
  readonly context: StackContext;
}

/** Describe an engine plan computed on a built stack. */
export const describeStackPlan = Effect.fn("Alchemist.describeStackPlan")(function* <Output>(
  built: {
    readonly stack: { readonly name: string; readonly stage: string };
    readonly context: StackContext;
  },
  native: Plan.Plan<Output>,
) {
  yield* emit({ type: "plan.phase", phase: "plan-ready" });
  return {
    stack: { name: built.stack.name, stage: built.stack.stage },
    summary: summarize(native),
    ...Plan.describePlan(native),
    native,
    context: built.context,
  } satisfies StackPlan<Output>;
});

/**
 * Run the stack's program and plan what to create, update, replace, and
 * delete so the stage matches it.
 */
export interface DeployPlanOptions extends BuildOptions, ResourceSelection {
  readonly operation: "deploy";
  /** Re-run every Action regardless of input drift. */
  readonly force?: boolean;
}

/**
 * Plan deleting everything the stage owns. The program never runs, so this
 * works even when it no longer does. Always the whole stage.
 */
export interface DestroyPlanOptions extends BuildOptions {
  readonly operation: "destroy";
}

export type PlanOptions = DeployPlanOptions | DestroyPlanOptions;

/** What applying a plan made with `O` returns. */
export type PlanOutput<Output, O extends PlanOptions> = O extends { readonly operation: "destroy" }
  ? undefined
  : SelectionOutput<Output, O>;

/**
 * Plan a deploy or a destroy of `stack`. A filtered deploy plan applies to
 * `undefined` and leaves the persisted stack output untouched. The build,
 * and the stage's state-store lease, stay open until the surrounding
 * `Scope` closes.
 */
export const plan = Effect.fn("Alchemist.plan")(function* <
  Output,
  Req,
  const O extends PlanOptions,
>(input: O & { readonly stack: Stack.ConfiguredStack<Output, Req> }) {
  if (input.operation === "destroy") {
    const built = yield* buildWithoutProgram(input.stack, input);
    const native = yield* Plan.destroy(built.stack).pipe(Effect.provide(built.context));
    // SAFETY: `operation: "destroy"` is exactly when PlanOutput is `undefined`.
    return (yield* describeStackPlan(built, native)) as StackPlan<PlanOutput<Output, O>>;
  }
  // `operation` is "deploy" here; a generic `O` doesn't narrow.
  const deploy: DeployPlanOptions = input;
  const built = yield* buildStack(input.stack, deploy);
  const native = yield* Plan.make(built.stack, {
    force: deploy.force,
    include: deploy.include,
    exclude: deploy.exclude,
  }).pipe(Effect.provide(built.context));
  // SAFETY: for `deploy`, PlanOutput is the selection's output.
  return (yield* describeStackPlan(built, native)) as StackPlan<PlanOutput<Output, O>>;
});

/** Run a plan; a deploy returns the stack's output. */
export const apply = Effect.fn("Alchemist.apply")(function* <Output>(plan: StackPlan<Output>) {
  return yield* Effect.provide(Apply.apply(plan.native), plan.context);
});

/** Stage used when a stack's providers are built without addressing a deployment. */
export const PLACEHOLDER_STAGE = "placeholder";

/**
 * Build a stack's providers and state store without running its program or
 * addressing a stage: what account-wide operations like `Nuke.scan` need.
 */
export const buildProviders = <Req>(
  stack: Stack.ConfiguredStack<unknown, Req>,
  options: ConfigOptions = {},
) =>
  Effect.map(
    buildWithoutProgram(stack, { ...options, stage: PLACEHOLDER_STAGE }),
    (built) => built.context,
  );
