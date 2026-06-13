import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { asEffect } from ".//Util/types.ts";
import { isAction, type ActionLike } from "./Action.ts";
import {
  AdoptPolicy,
  OwnedBySomeoneElse,
  stripUnowned,
  Unowned,
} from "./AdoptPolicy.ts";
import { AlchemyContext } from "./AlchemyContext.ts";
import {
  Artifacts,
  ArtifactStore,
  createArtifactStore,
  ensureArtifactStore,
  makeScopedArtifacts,
} from "./Artifacts.ts";
import {
  dedupeBindings,
  diffBindings,
  havePropsChanged,
  isResolved,
  type NoopDiff,
  type UpdateDiff,
} from "./Diff.ts";
import { parseFqn } from "./FQN.ts";
import { generateInstanceId, InstanceId } from "./InstanceId.ts";
import * as Output from "./Output.ts";
import {
  findProviderByType,
  Provider,
  type ProviderService,
} from "./Provider.ts";
import {
  isResource,
  type ResourceBinding,
  type ResourceLike,
} from "./Resource.ts";
import { type StackSpec } from "./Stack.ts";
import {
  isActionState,
  State,
  type ActionState,
  type CreatedResourceState,
  type CreatingResourceState,
  type RanActionState,
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  type UpdatedResourceState,
  type UpdatingReourceState,
} from "./State/index.ts";
import { hashInput } from "./Util/hash.ts";
import { findCycleMembers } from "./Util/scc.ts";

export type PlanError = never;

export const isCRUD = (node: any): node is CRUD => {
  return (
    node &&
    typeof node === "object" &&
    (node.action === "create" ||
      node.action === "update" ||
      node.action === "replace" ||
      node.action === "noop")
  );
};

/**
 * A node in the plan that represents a resource CRUD operation.
 */
export type CRUD<R extends ResourceLike = ResourceLike> =
  | Create<R>
  | Update<R>
  | Delete<R>
  | Replace<R>
  | NoopUpdate<R>;

export type Apply<R extends ResourceLike = ResourceLike> =
  | Create<R>
  | Update<R>
  | Replace<R>
  | NoopUpdate<R>;

export type BindingAction = "create" | "update" | "delete" | "noop";

export interface BindingNode<Data = any> extends ResourceBinding {
  action: BindingAction;
  data: Data;
}

export interface BaseNode<
  R extends ResourceLike<string> = ResourceLike<string>,
> {
  resource: R;
  provider: ProviderService<R>;
  downstream: string[];
  bindings: BindingNode<R["Binding"]>[];
}

export interface Create<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "create";
  props: R["Props"];
  state: CreatingResourceState | undefined;
}

export interface Update<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "update";
  props: R["Props"];
  state:
    | CreatedResourceState
    | UpdatedResourceState
    | UpdatingReourceState
    // the props can change after creating the replacement resource,
    // so Apply needs to handle updates and then continue with cleaning up the replaced graph
    | ReplacedResourceState;
}

export interface Delete<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "delete";
  // a resource can be deleted no matter what state it's in
  state: ResourceState;
}

export interface NoopUpdate<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "noop";
  state: CreatedResourceState | UpdatedResourceState;
}

export interface Replace<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "replace";
  props: any;
  deleteFirst: boolean;
  restart?: boolean;
  state:
    | CreatingResourceState
    | CreatedResourceState
    | UpdatingReourceState
    | UpdatedResourceState
    | ReplacingResourceState
    | ReplacedResourceState;
}

// ── Tasks ──────────────────────────────────────────────────────────────────
//
// Tasks live in the same FQN namespace as resources and participate in the
// same DAG (downstream/upstream edges, cycle detection). Their plan nodes
// have a different shape because they have no provider lifecycle.

export type ActionApply<T extends ActionLike = ActionLike> =
  | ActionRun<T>
  | ActionNoop<T>;

export interface ActionNodeBase<T extends ActionLike = ActionLike> {
  readonly kind: "action";
  def: T;
  downstream: string[];
}

export interface ActionRun<
  T extends ActionLike = ActionLike,
> extends ActionNodeBase<T> {
  action: "run";
  /** Input expression — resolved against tracker outputs during apply. */
  input: T["Input"];
  /** Previous state, if any. `undefined` on the first run. */
  state: ActionState | undefined;
  /** True when `--force` triggered the re-run regardless of input drift. */
  forced: boolean;
}

export interface ActionNoop<
  T extends ActionLike = ActionLike,
> extends ActionNodeBase<T> {
  action: "noop";
  state: RanActionState;
}

export interface ActionDelete<
  T extends ActionLike = ActionLike,
> extends ActionNodeBase<T> {
  action: "delete";
  state: ActionState;
}

export type Plan<Output = any> = {
  resources: {
    [id in string]: Apply<any>;
  };
  /**
   * Tasks scheduled for this apply. Keyed by FQN, same namespace as
   * `resources` — Apply's scheduler merges both into a single DAG.
   */
  actions: {
    [id in string]: ActionApply;
  };
  deletions: {
    [id in string]?: Delete<ResourceLike>;
  };
  /** Tasks whose state should be dropped (no body invoked on removal). */
  actionDeletions: {
    [id in string]?: ActionDelete;
  };
  output: Output;
  /**
   * FQNs of resources that participate in a strongly-connected component
   * of the upstream dependency graph (or have a self-edge). The scheduler
   * uses this to decide whether an `update` node must publish its prior
   * attr early to break the cycle, or can simply wait for upstreams and
   * publish a fresh attr (the common, linear case).
   */
  cycleMembers: ReadonlySet<string>;
};

export interface MakePlanOptions {
  force?: boolean;
}

export const make = <A>(
  stack: StackSpec<A>,
  options: MakePlanOptions = {},
): Effect.Effect<Plan<A>, never, State> =>
  // @ts-expect-error
  Effect.gen(function* () {
    const state = yield* yield* State;

    const resources = Object.values(stack.resources);
    const actions = Object.values(stack.actions ?? {});

    // TODO(sam): rename terminology to Stack
    const stackName = stack.name;
    const stage = stack.stage;

    // Resolve the effective adoption setting for this plan. AdoptPolicy
    // (provided by the CLI or scoped via `adopt(...)`) takes precedence; if
    // unset, fall back to the AlchemyContext's `adopt` default; otherwise
    // adoption is disabled.
    const shouldAdopt = Effect.gen(function* () {
      const fromService = yield* Effect.serviceOption(AdoptPolicy);
      if (Option.isSome(fromService)) return fromService.value;
      const ctx = yield* Effect.serviceOption(AlchemyContext);
      return Option.match(ctx, {
        onNone: () => false,
        onSome: (c) => c.adopt,
      });
    });

    const resourceFqns = yield* state.list({
      stack: stackName,
      stage: stage,
    });
    const oldResources = yield* Effect.all(
      resourceFqns.map((fqn) =>
        state.get({ stack: stackName, stage: stage, fqn }),
      ),
      { concurrency: "unbounded" },
    );

    const resolvedResources: Record<string, Effect.Effect<any>> = {};

    const resolveResource = (
      resourceExpr: Output.ResourceExpr<any, any>,
    ): Effect.Effect<any> =>
      Effect.gen(function* () {
        // Tasks share the ResourceExpr machinery but have no provider /
        // stable-properties story at plan time. Leave the expression
        // unsubstituted — Apply resolves it from the tracker at run time.
        if (isAction(resourceExpr.src as any)) {
          return resourceExpr;
        }
        // @ts-expect-error
        return yield* (resolvedResources[resourceExpr.src.FQN] ??=
          yield* Effect.cached(
            Effect.gen(function* () {
              const resource = resourceExpr.src;

              const provider = yield* findProviderByType(resource.Type);
              const props = yield* resolveInput(resource.Props);
              const persisted = yield* state.get({
                stack: stackName,
                stage: stage,
                fqn: resource.FQN,
              });
              const oldState: ResourceState | undefined = isActionState(
                persisted,
              )
                ? undefined
                : (persisted as ResourceState | undefined);

              if (!oldState || oldState.status === "creating") {
                return resourceExpr;
              }

              const oldProps =
                oldState.status === "updating"
                  ? oldState.old.props
                  : oldState.props;

              const oldBindings = oldState.bindings ?? [];
              // Collapse duplicate bindings by sid so the binding set handed to
              // `diff` matches what `reconcile` receives (see `dedupeBindings`).
              const newBindings = dedupeBindings(
                stack.bindings[resource.FQN] ?? [],
              );

              const diff = yield* provider.diff
                ? provider
                    .diff({
                      id: resource.LogicalId,
                      olds: oldProps,
                      instanceId: oldState.instanceId,
                      news: props,
                      output: oldState.attr,
                      oldBindings,
                      newBindings,
                    })
                    .pipe(providePlanScope(resource.FQN, oldState.instanceId))
                : Effect.succeed(undefined);

              const stables: string[] = [
                ...(provider.stables ?? []),
                ...(diff?.stables ?? []),
              ];

              const withStables = (output: any) =>
                stables.length > 0
                  ? new Output.ResourceExpr(
                      resourceExpr.src,
                      Object.fromEntries(
                        stables.map((stable) => [stable, output?.[stable]]),
                      ),
                    )
                  : // if there are no stable properties, treat every property as changed
                    resourceExpr;

              if (diff == null) {
                if (havePropsChanged(oldProps, props)) {
                  // the props have changed but the provider did not provide any hints as to what is stable
                  // so we must assume everything has changed
                  return withStables(oldState?.attr);
                }
              } else if (diff.action === "update") {
                return withStables(oldState?.attr);
              } else if (diff.action === "replace") {
                return resourceExpr;
              }
              if (
                oldState.status === "created" ||
                oldState.status === "updated" ||
                oldState.status === "replaced"
              ) {
                // we can safely return the attributes if we know they have stabilized
                return oldState?.attr;
              } else {
                // we must assume the resource doesn't exist if it hasn't stabilized
                return resourceExpr;
              }
            }),
          ));
      });

    const resolveInput = (input: any): Effect.Effect<any> =>
      Effect.gen(function* () {
        if (!input) {
          return input;
        } else if (Output.isExpr(input)) {
          return yield* resolveOutput(input);
        } else if (Redacted.isRedacted(input)) {
          return input;
        } else if (Duration.isDuration(input)) {
          // Duration is an opaque value; walking its internal `.value`
          // would destroy the prototype and produce a plain `{ value: ... }`
          // object that downstream consumers can't interpret.
          return input;
        } else if (Array.isArray(input)) {
          return yield* Effect.all(input.map(resolveInput), {
            concurrency: "unbounded",
          });
        } else if (isResource(input)) {
          // Resource objects have dynamic properties (path, hash, etc.) that are
          // created on-demand by a Proxy getter and aren't enumerable via Object.entries.
          // Resolve the ResourceExpr to get the actual resource output, then continue
          // resolving any nested outputs in the result.
          const resourceExpr = Output.of(input);
          const resolved = yield* resolveOutput(resourceExpr);
          return yield* resolveInput(resolved);
        } else if (typeof input === "object") {
          return Object.fromEntries(
            yield* Effect.all(
              Object.entries(input).map(([key, value]) =>
                resolveInput(value).pipe(Effect.map((value) => [key, value])),
              ),
              { concurrency: "unbounded" },
            ),
          );
        }
        return input;
      });

    const resolveOutput = (expr: Output.Expr<any>): Effect.Effect<any> =>
      Effect.gen(function* () {
        if (Output.isResourceExpr(expr)) {
          return yield* resolveResource(expr);
        } else if (Output.isPropExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          return upstream?.[expr.identifier];
        } else if (Output.isApplyExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          return Output.hasOutputs(upstream) ? expr : expr.f(upstream);
        } else if (Output.isEffectExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          return Output.hasOutputs(upstream) ? expr : yield* expr.f(upstream);
        } else if (Output.isFlatMapExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          // Source still unresolved -> keep the flatMap intact for a later pass.
          // Otherwise run `f` to produce the next Output and resolve into it.
          return Output.hasOutputs(upstream)
            ? expr
            : yield* resolveOutput(
                Output.asOutput(expr.f(upstream)) as Output.Expr<any>,
              );
        } else if (Output.isAllExpr(expr)) {
          return yield* Effect.all(expr.outs.map(resolveOutput), {
            concurrency: "unbounded",
          });
        } else if (Output.isLiteralExpr(expr)) {
          return expr.value;
        } else if (Output.isRefExpr(expr)) {
          const refStack = expr.stack ?? stackName;
          const refStage = expr.stage ?? stage;
          const refState = yield* state
            .get({
              stack: refStack,
              stage: refStage,
              fqn: expr.resourceId,
            })
            .pipe(Effect.orDie);
          if (!refState) {
            return yield* Effect.die(
              new Output.InvalidReferenceError({
                message: `Reference to '${expr.resourceId}' in stack '${refStack}' and stage '${refStage}' not found. Have you deployed '${refStage}' of '${refStack}'?`,
                stack: refStack,
                stage: refStage,
                resourceId: expr.resourceId,
              }),
            );
          }
          return (refState as any).attr ?? (refState as any).output;
        } else if (Output.isStackRefExpr(expr)) {
          const refStack = expr.stack;
          const refStage = expr.stage ?? stage;
          const output = yield* state
            .getOutput({
              stack: refStack,
              stage: refStage,
            })
            .pipe(Effect.orDie);
          if (output == null) {
            return yield* Effect.die(
              new Output.InvalidReferenceError({
                message: `Reference to stack '${refStack}' at stage '${refStage}' not found. Have you deployed stage '${refStage}' of '${refStack}'?`,
                stack: refStack,
                stage: refStage,
                resourceId: refStack,
              }),
            );
          }
          return output;
        } else if (Output.isNamedExpr(expr)) {
          return yield* resolveOutput(expr.expr);
        }
        return yield* Effect.die(
          new Error("Not implemented yet" + (expr as any).kind),
        );
      });

    // map of resource FQN -> its downstream dependencies (resources that depend on it)
    const oldDownstreamDependencies: {
      [fqn: string]: string[];
    } = Object.fromEntries(
      oldResources
        .filter((resource) => !!resource)
        .map((resource) => [resource.fqn, resource.downstream]),
    );

    // Build a set of FQNs for the new resources to detect orphans
    const newResourceFqns = new Set(resources.map((r) => r.FQN));
    const newActionFqns = new Set(actions.map((t) => t.FQN));
    // Unified set used wherever the DAG must include both kinds.
    const newNodeFqns = new Set<string>([...newResourceFqns, ...newActionFqns]);

    // Map FQN -> list of upstream FQNs (resources this one depends on via props).
    // Tasks contribute upstream edges through their `Input` expression.
    const newUpstreamDependencies: {
      [fqn: string]: string[];
    } = Object.fromEntries([
      ...resources.map(
        (resource) =>
          [
            resource.FQN,
            Object.values(Output.upstreamAny(resource.Props)).map((r) => r.FQN),
          ] as const,
      ),
      ...actions.map(
        (action) =>
          [
            action.FQN,
            Object.values(Output.upstreamAny(action.Input)).map((r) => r.FQN),
          ] as const,
      ),
    ]);

    // Map FQN -> list of upstream FQNs from bindings
    const bindingUpstreamDependencies: {
      [fqn: string]: string[];
    } = Object.fromEntries(
      resources.map((resource) => [
        resource.FQN,
        Object.values(
          Output.upstreamAny(stack.bindings[resource.FQN] ?? []),
        ).map((r) => r.FQN),
      ]),
    );

    // Combined prop + binding upstream for the desired graph, including
    // references to resources outside the current graph so delete validation can
    // tell whether any surviving resource still points at an orphan.
    const rawUpstreamDependencies: {
      [fqn: string]: string[];
    } = Object.fromEntries<string[]>([
      ...resources.map((resource): [string, string[]] => {
        const fqn = resource.FQN;
        const propDeps = newUpstreamDependencies[fqn] ?? [];
        const bindDeps = bindingUpstreamDependencies[fqn] ?? [];
        return [fqn, [...new Set([...propDeps, ...bindDeps])]];
      }),
      // Actions have no bindings — their upstream is purely their input.
      ...actions.map((action): [string, string[]] => {
        const fqn = action.FQN;
        return [fqn, newUpstreamDependencies[fqn] ?? []];
      }),
    ]);

    // Combined prop + binding upstream, filtered to resources/tasks in this
    // graph for scheduling and cycle detection.
    const allUpstreamDependencies: {
      [fqn: string]: string[];
    } = Object.fromEntries([
      ...resources.map((resource) => {
        const fqn = resource.FQN;
        const deps = rawUpstreamDependencies[fqn] ?? [];
        return [fqn, deps.filter((dep) => newNodeFqns.has(dep))] as const;
      }),
      ...actions.map((action) => {
        const fqn = action.FQN;
        const deps = newUpstreamDependencies[fqn] ?? [];
        return [fqn, deps.filter((dep) => newNodeFqns.has(dep))] as const;
      }),
    ]);

    // Resources that participate in a cycle when both prop and binding
    // edges are considered. Used below to decide whether an acyclic
    // binding edge should also become a downstream edge.
    const combinedCycleMembers = findCycleMembers(allUpstreamDependencies);

    // Map FQN -> list of downstream FQNs (resources/actions that depend on
    // this one).
    //
    // Prop edges always become downstream edges — they can't form cycles
    // (the resource graph is a DAG by construction once props are fully
    // resolved). Binding edges become downstream edges too, except when
    // they participate in a cycle in the combined graph: mutual bindings
    // (A binds to B's data, B binds to A's data) intentionally do not
    // create downstream edges, so deletion does not deadlock waiting on
    // each other (see the "binding-only cycles inside a construct" test
    // in `plan.test.ts`).
    //
    // Including acyclic binding edges is required for cloud APIs that
    // enforce the binding at the provider level — e.g. a Cloudflare
    // Worker with a `service` binding to another Worker cannot delete
    // the upstream worker until the downstream worker's binding has been
    // removed. Without the binding edge in `downstream`, the two delete
    // concurrently and the upstream delete fails with
    // `ServiceBindingConflict`.
    //
    // Actions don't have bindings, so for action upstreams we use only
    // prop edges (which collapse to `newUpstreamDependencies` lookups).
    const computeDownstream = (upFqn: string): string[] => {
      const downstream: string[] = [];
      for (const [downFqn, upstreams] of Object.entries(
        rawUpstreamDependencies,
      )) {
        if (downFqn === upFqn) continue;
        if (!upstreams.includes(upFqn)) continue;
        const isPropEdge = (newUpstreamDependencies[downFqn] ?? []).includes(
          upFqn,
        );
        if (isPropEdge) {
          downstream.push(downFqn);
          continue;
        }
        // Binding-only edge — exclude when both endpoints sit inside
        // the same SCC of the combined graph.
        if (
          combinedCycleMembers.has(upFqn) &&
          combinedCycleMembers.has(downFqn)
        ) {
          continue;
        }
        downstream.push(downFqn);
      }
      return downstream;
    };

    const newDownstreamDependencies: {
      [fqn: string]: string[];
    } = Object.fromEntries([
      ...resources.map(
        (resource) => [resource.FQN, computeDownstream(resource.FQN)] as const,
      ),
      ...actions.map(
        (action) => [action.FQN, computeDownstream(action.FQN)] as const,
      ),
    ]);

    const resourceGraph = Object.fromEntries(
      (yield* Effect.all(
        resources.map(
          Effect.fn("plan.diff.resource")(function* (resource) {
            const provider = yield* findProviderByType(resource.Type);
            const id = resource.LogicalId;
            const fqn = resource.FQN;
            const news = yield* resolveInput(resource.Props);
            const downstream = newDownstreamDependencies[fqn] ?? [];

            // Collapse duplicate bindings by sid so the binding set handed to
            // `diff` matches what `reconcile` receives (see `dedupeBindings`).
            const newBindings: ResourceBinding[] = dedupeBindings(
              yield* resolveInput(stack.bindings[fqn] ?? []),
            );
            const persisted = yield* state.get({
              stack: stackName,
              stage: stage,
              fqn,
            });
            // A Task previously held this FQN. Treat as if there were no
            // prior state — the Task's row will be reaped by `actionDeletions`
            // below and the resource starts from scratch.
            let oldState: ResourceState | undefined = isActionState(persisted)
              ? undefined
              : (persisted as ResourceState | undefined);

            // Engine-level adoption. When there is no prior state, always
            // consult `provider.read` (if implemented) so the engine — not
            // each lifecycle method — owns the existence/ownership decision.
            //
            // The provider returns one of:
            //   - `undefined`        → resource doesn't exist; create it
            //   - plain attrs        → exists and is owned by us; silent adopt
            //   - `Unowned(attrs)`   → exists but is *not* ours
            //
            // Routing:
            //   - owned                          → persist `created` state
            //                                      from attrs and continue
            //                                      through the normal diff
            //                                      path (so subsequent props
            //                                      drift produces an update).
            //   - unowned + adopt enabled        → take over: persist `created`
            //                                      state and let the next
            //                                      update overwrite tags / etc.
            //   - unowned + adopt disabled       → fail with
            //                                      `OwnedBySomeoneElse`.
            // After a cold-start adoption (engine just discovered an
            // existing cloud resource via `read`), force the engine's
            // normal `update` path so the provider can re-sync ownership
            // tags, configuration, etc. against the desired props.
            // Adoption persists state with `props: news`, so the default
            // diff sees no drift and would noop — which would leave any
            // foreign-owned tags / divergent config in place. Forcing
            // update keeps the deploy idempotent: if cloud state already
            // matches news, the provider's update is a no-op write.
            //
            // Skip the adoption probe entirely when `news` still contains
            // unresolved upstream Outputs (e.g. a `streamArn` referencing
            // a stream being created in the same plan). Calling `read` with
            // an unresolved value would surface as `ParseError` from the
            // SDK protocol layer. Resources whose props depend on
            // not-yet-created upstreams cannot themselves be pre-existing
            // — there's nothing to adopt.
            let forceUpdateAfterAdoption = false;
            if (oldState === undefined && provider.read && isResolved(news)) {
              const adoptInstanceId = yield* generateInstanceId();
              const readResult = yield* provider
                .read({
                  id,
                  instanceId: adoptInstanceId,
                  olds: news,
                  output: undefined,
                })
                .pipe(providePlanScope(fqn, adoptInstanceId));
              if (readResult !== undefined) {
                const isUnowned = Unowned.is(readResult);
                if (isUnowned && !(yield* shouldAdopt)) {
                  return yield* new OwnedBySomeoneElse({
                    message:
                      `Cannot adopt resource '${fqn}' (${resource.Type}): ` +
                      "it exists in the cloud but is not owned by this " +
                      "stack/stage/logical-id. Re-run with `--adopt` (or " +
                      "wrap the effect in `adopt(true)`) to take it over.",
                    resourceType: resource.Type,
                    logicalId: id,
                  });
                }
                const adoptedState = {
                  status: "created" as const,
                  fqn,
                  logicalId: id,
                  instanceId: adoptInstanceId,
                  namespace: resource.Namespace,
                  resourceType: resource.Type,
                  props: news,
                  attr: stripUnowned(readResult),
                  providerVersion: provider.version ?? 0,
                  bindings: [],
                  downstream,
                  removalPolicy: resource.RemovalPolicy,
                } satisfies CreatedResourceState;
                yield* state.set({
                  stack: stackName,
                  stage: stage,
                  fqn,
                  value: adoptedState,
                });
                oldState = adoptedState;
                forceUpdateAfterAdoption = true;
              }
            }

            const oldBindings = oldState?.bindings ?? [];
            const bindingDiffs = diffBindings(oldBindings, newBindings);

            const Node = <T extends Apply>(
              node: Omit<
                T,
                "provider" | "resource" | "bindings" | "downstream"
              >,
            ) =>
              ({
                ...node,
                provider,
                resource,
                bindings: bindingDiffs,
                downstream,
              }) as any as T;

            // Plan against the persisted state we have, not the ideal final state we
            // hoped to reach last time. Recovery is expressed by mapping each
            // intermediate state back onto a fresh CRUD action.
            if (oldState === undefined) {
              return Node<Create>({
                action: "create",
                props: news,
                state: oldState,
              });
            } else if (
              oldState.status === "creating" &&
              oldState.attr === undefined
            ) {
              // A create may have succeeded before state persistence failed. If the
              // provider can recover an attribute snapshot, keep driving the same
              // create instead of starting over blindly.
              if (provider.read) {
                const attr = yield* provider
                  .read({
                    id,
                    instanceId: oldState.instanceId,
                    olds: oldState.props,
                    output: oldState.attr,
                  })
                  .pipe(providePlanScope(fqn, oldState.instanceId));
                if (attr) {
                  return Node<Create>({
                    action: "create",
                    props: news,
                    state: { ...oldState, attr },
                  });
                }
              }
            }

            // Diff against whatever props represent the best-known current attempt.
            // For replacement recovery that means the top-level replacement props,
            // not the older generations stored under `old`.
            const oldProps = oldState.props;

            const diff = yield* asEffect(
              provider
                ?.diff?.({
                  id,
                  olds: oldProps,
                  instanceId: oldState.instanceId,
                  output: oldState.attr,
                  news,
                  oldBindings,
                  newBindings,
                })
                .pipe(providePlanScope(fqn, oldState.instanceId)),
            ).pipe(
              Effect.map(
                (diff) =>
                  diff ??
                  ({
                    action:
                      havePropsChanged(oldProps, news) ||
                      bindingDiffs.some((b) => b.action !== "noop")
                        ? "update"
                        : "noop",
                  } as UpdateDiff | NoopDiff),
              ),
              Effect.map((diff) =>
                options.force && diff.action === "noop"
                  ? ({
                      action: "update",
                    } satisfies UpdateDiff)
                  : diff,
              ),
              // After a cold-start adoption (silent or takeover), force at
              // least an update so the provider re-syncs ownership tags /
              // config against the desired props (otherwise the engine
              // would noop and any drift between the existing cloud
              // resource and `news` — including foreign-owned tags after a
              // takeover — would persist).
              Effect.map((diff) =>
                forceUpdateAfterAdoption && diff.action === "noop"
                  ? ({ action: "update" } satisfies UpdateDiff)
                  : diff,
              ),
            );

            if (oldState.status === "creating") {
              if (diff.action === "noop") {
                // we're in the creating state and props are un-changed
                // let's just continue where we left off
                return Node<Create>({
                  action: "create",
                  props: news,
                  state: oldState,
                });
              } else if (diff.action === "update") {
                // props have changed in a way that is updatable
                // again, just continue with the create
                // TODO(sam): should we maybe try an update instead?
                return Node<Create>({
                  action: "create",
                  props: news,
                  state: oldState,
                });
              } else {
                // props have changed in an incompatible way
                // because it's possible that an un-updatable resource has already been created
                // we must use a replace step to create a new one and delete the potential old one
                return Node<Replace>({
                  action: "replace",
                  props: news,
                  deleteFirst: diff.deleteFirst ?? false,
                  state: oldState,
                });
              }
            } else if (oldState.status === "updating") {
              // Updating already targets the live resource, so noop/update both mean
              // "finish the interrupted update". Only a replace diff escalates it
              // into a fresh replacement.
              if (diff.action === "update" || diff.action === "noop") {
                // we can continue where we left off
                return Node<Update>({
                  action: "update",
                  props: news,
                  state: oldState,
                });
              } else {
                // we started to update a resource but now believe we should replace it
                return Node<Replace>({
                  action: "replace",
                  deleteFirst: diff.deleteFirst ?? false,
                  props: news,
                  // TODO(sam): can Apply handle replacements when the oldState is UpdatingResourceState?
                  // -> or should we do a provider.read to try and reconcile back to UpdatedResourceState?
                  state: oldState,
                });
              }
            } else if (oldState.status === "replacing") {
              // The replacement candidate is still being created. Noop/update keep
              // driving the same generation; replace means that candidate itself is
              // now obsolete and must be wrapped in a new outer generation.
              if (diff.action === "noop") {
                // this is the stable case - noop means just continue with the replacement
                return Node<Replace>({
                  action: "replace",
                  deleteFirst: oldState.deleteFirst,
                  props: news,
                  state: oldState,
                });
              } else if (diff.action === "update") {
                // potential problem here - the props have changed since we tried to replace,
                // but not enough to trigger another replacement. the resource provider should
                // be designed as idempotent to converge to the right state when creating the new resource
                // the newly generated instanceId is intended to assist with this
                return Node<Replace>({
                  action: "replace",
                  deleteFirst: oldState.deleteFirst,
                  props: news,
                  state: oldState,
                });
              } else {
                // The in-flight replacement candidate itself now needs replacement.
                // Mark this as a restart so Apply creates a fresh generation instead
                // of resuming the old replacement instance.
                return Node<Replace>({
                  restart: true,
                  action: "replace",
                  deleteFirst: diff.deleteFirst ?? oldState.deleteFirst,
                  props: news,
                  state: oldState,
                });
              }
            } else if (oldState.status === "replaced") {
              // The new resource already exists. Noop means "just let GC finish",
              // update means "mutate the current replacement before GC finishes",
              // and replace means "the current replacement also became obsolete".
              if (diff.action === "noop") {
                // this is the stable case - noop means just continue cleaning up the replacement
                return Node<Replace>({
                  action: "replace",
                  deleteFirst: oldState.deleteFirst,
                  props: news,
                  state: oldState,
                });
              } else if (diff.action === "update") {
                // the replacement has been created but now also needs to be updated
                // the resource provider should:
                // 1. Update the newly created replacement resource
                // 2. Then proceed as normal to delete the replaced resources (after all downstream references are updated)
                return Node<Update>({
                  action: "update",
                  props: news,
                  state: oldState,
                });
              } else {
                // Cleanup is still pending, but the current "new" resource has already
                // become obsolete. Start another replacement generation and preserve
                // the existing replaced node as part of the recursive old chain.
                return Node<Replace>({
                  restart: true,
                  action: "replace",
                  deleteFirst: diff.deleteFirst ?? oldState.deleteFirst,
                  props: news,
                  state: oldState,
                });
              }
            } else if (oldState.status === "deleting") {
              // we're in a partially deleted state, it is unclear whether it was or was not deleted
              // so continue by re-creating it with the same instanceId and desired props
              return Node<Create>({
                action: "create",
                props: news,
                state: {
                  ...oldState,
                  status: "creating",
                  props: news,
                },
              });
            } else if (diff.action === "update") {
              // Stable created/updated resources follow the normal CRUD mapping.
              return Node<Update>({
                action: "update",
                props: news,
                state: oldState,
              });
            } else if (diff.action === "replace") {
              return Node<Replace>({
                action: "replace",
                props: news,
                state: oldState,
                deleteFirst: diff?.deleteFirst ?? false,
              });
            } else {
              return Node<NoopUpdate>({
                action: "noop",
                state: oldState,
              });
            }
          }),
        ),
        { concurrency: "unbounded" },
      )).map((update) => [update.resource.FQN, update]),
    ) as Plan["resources"];

    // ── Action plan nodes ────────────────────────────────────────────────
    const actionGraph = Object.fromEntries(
      (yield* Effect.all(
        actions.map(
          Effect.fn("plan.diff.action")(function* (action) {
            const fqn = action.FQN;
            const downstream = newDownstreamDependencies[fqn] ?? [];
            const resolvedInput = yield* resolveInput(action.Input);
            const inputHash = yield* hashInput(resolvedInput);
            const oldState = yield* state.get({
              stack: stackName,
              stage,
              fqn,
            });

            if (oldState && !isActionState(oldState)) {
              // FQN collision with a resource — surface as a fatal error so
              // the user resolves it before we touch anything.
              return [
                fqn,
                {
                  kind: "action",
                  action: "run",
                  def: action,
                  input: action.Input,
                  state: undefined,
                  downstream,
                  forced: false,
                } satisfies ActionRun,
              ] as const;
            }

            const prior = oldState as ActionState | undefined;
            const sameInput =
              prior?.status === "ran" && prior.inputHash === inputHash;
            if (sameInput && !options.force) {
              return [
                fqn,
                {
                  kind: "action",
                  action: "noop",
                  def: action,
                  state: prior as RanActionState,
                  downstream,
                } satisfies ActionNoop,
              ] as const;
            }
            return [
              fqn,
              {
                kind: "action",
                action: "run",
                def: action,
                input: action.Input,
                state: prior,
                downstream,
                forced: !!options.force,
              } satisfies ActionRun,
            ] as const;
          }),
        ),
        { concurrency: "unbounded" },
      )) as ReadonlyArray<readonly [string, ActionApply]>,
    ) as Plan["actions"];

    // SCC membership of the combined upstream graph. Apply uses it to
    // decide whether an update node must publish its prior attr early to
    // break a cycle, or can simply wait for upstreams like a DAG node
    // (the common case). Computed once, above, for the downstream graph.
    const cycleMembers = combinedCycleMembers;

    // Detect unsatisfiable dependency cycles among create/replace nodes.
    // Update/noop nodes signal their Deferred before waitForDeps when in a
    // cycle so they cannot deadlock. Create/replace nodes only signal
    // early when they have a precreate handler. Simulate the concurrent
    // execution: precreate nodes are immediately "resolved", then
    // iteratively resolve any node whose deps are all resolved. Remaining
    // nodes would deadlock.
    {
      const createReplaceNodes = new Set(
        Object.entries(resourceGraph)
          .filter(
            ([_, node]) =>
              node.action === "create" || node.action === "replace",
          )
          .map(([fqn]) => fqn),
      );

      if (createReplaceNodes.size > 0) {
        const hasPrecreate = new Set(
          [...createReplaceNodes].filter(
            (fqn) => !!resourceGraph[fqn]?.provider?.precreate,
          ),
        );

        const resolved = new Set(hasPrecreate);
        let changed = true;
        while (changed) {
          changed = false;
          for (const fqn of createReplaceNodes) {
            if (resolved.has(fqn)) continue;
            const deps = (allUpstreamDependencies[fqn] ?? []).filter((dep) =>
              createReplaceNodes.has(dep),
            );
            if (deps.every((dep) => resolved.has(dep))) {
              resolved.add(fqn);
              changed = true;
            }
          }
        }

        const deadlocked = [...createReplaceNodes].filter(
          (fqn) => !resolved.has(fqn),
        );
        if (deadlocked.length > 0) {
          const missingPrecreate = deadlocked.filter(
            (fqn) => !hasPrecreate.has(fqn),
          );
          return yield* Effect.die(
            new UnsatisfiedResourceCycle({
              message:
                `Circular dependency detected that cannot be resolved: [${deadlocked.join(", ")}]. ` +
                `Resources lacking a precreate handler: [${missingPrecreate.join(", ")}]. ` +
                `All resources in a dependency cycle must implement precreate to allow early signaling.`,
              cycle: deadlocked,
              missingPrecreate,
            }),
          );
        }
      }
    }

    // Task deletions: state rows previously written by tasks that no
    // longer appear in the stack. The body is NOT invoked — we just drop
    // the row.
    const actionDeletions: Plan["actionDeletions"] = Object.fromEntries(
      (yield* Effect.all(
        (yield* state.list({ stack: stackName, stage })).map(
          Effect.fn("plan.diff.actionDeletion")(function* (fqn) {
            if (newActionFqns.has(fqn) || newResourceFqns.has(fqn)) return;
            const persisted = yield* state.get({
              stack: stackName,
              stage,
              fqn,
            });
            if (!isActionState(persisted)) return;
            const { logicalId } = parseFqn(fqn);
            return [
              fqn,
              {
                kind: "action",
                action: "delete",
                state: persisted,
                downstream: persisted.downstream ?? [],
                def: {
                  Kind: "action",
                  Namespace: persisted.namespace,
                  FQN: fqn,
                  LogicalId: logicalId,
                  Type: persisted.actionType,
                  Input: persisted.input,
                  Run: () => undefined as any,
                  Output: undefined as any,
                } satisfies ActionLike,
              } satisfies ActionDelete,
            ] as const;
          }),
        ),
        { concurrency: "unbounded" },
      )).filter((v): v is NonNullable<typeof v> => !!v),
    );

    const deletions = Object.fromEntries(
      (yield* Effect.all(
        (yield* state.list({ stack: stackName, stage: stage })).map(
          Effect.fn("plan.diff.deletion")(function* (fqn) {
            if (newResourceFqns.has(fqn) || newActionFqns.has(fqn)) {
              return;
            }
            const persisted = yield* state.get({
              stack: stackName,
              stage: stage,
              fqn,
            });
            // Tasks are routed through `actionDeletions` above.
            if (isActionState(persisted)) return;
            const oldState = persisted as ResourceState | undefined;
            let attr: any = oldState?.attr;
            if (oldState) {
              const { logicalId } = parseFqn(fqn);
              const resourceType = oldState.resourceType;
              const provider = yield* findProviderByType(resourceType);
              if (oldState.attr === undefined) {
                if (provider.read) {
                  attr = yield* provider
                    .read({
                      id: logicalId,
                      instanceId: oldState.instanceId,
                      olds: oldState.props as never,
                      output: oldState.attr as never,
                    })
                    .pipe(providePlanScope(fqn, oldState.instanceId));
                }
              }
              return [
                fqn,
                {
                  action: "delete",
                  state: { ...oldState, attr },
                  provider: provider,
                  resource: {
                    Namespace: oldState.namespace,
                    FQN: fqn,
                    LogicalId: logicalId,
                    Type: oldState.resourceType,
                    Attributes: attr,
                    Props: oldState.props,
                    Binding: undefined!,
                    Provider: Provider(resourceType),
                    RemovalPolicy: oldState.removalPolicy,
                    RuntimeContext: undefined!,
                    Providers: undefined,
                  } as ResourceLike,
                  downstream: oldDownstreamDependencies[fqn] ?? [],
                  bindings: oldState.bindings.map((binding) => ({
                    sid: binding.sid,
                    action: "delete" as const,
                    data: binding.data,
                  })),
                } satisfies Delete,
              ] as const;
            }
          }),
        ),
        { concurrency: "unbounded" },
      )).filter((v) => !!v),
    );

    for (const resourceFqn of Object.keys(deletions)) {
      const dependencies = Object.entries(rawUpstreamDependencies)
        .filter(
          ([survivorFqn, upstream]) =>
            survivorFqn in resourceGraph && upstream.includes(resourceFqn),
        )
        .map(([survivorFqn]) => survivorFqn);
      if (dependencies.length > 0) {
        return yield* new DeleteResourceHasDownstreamDependencies({
          message: `Resource ${resourceFqn} has downstream dependencies`,
          resourceId: resourceFqn,
          dependencies,
        });
      }
    }

    return {
      resources: resourceGraph,
      actions: actionGraph,
      deletions,
      actionDeletions,
      output: stack.output,
      cycleMembers,
    } satisfies Plan<A> as Plan<A>;
  }).pipe(
    ensureArtifactStore,
    Effect.withSpan("plan.make", {
      attributes: {
        "alchemy.stack": stack.name,
        "alchemy.stage": stack.stage,
        "alchemy.resources.count": Object.keys(stack.resources).length,
        "alchemy.force": !!options.force,
      },
    }),
  );

const providePlanScope =
  (fqn: string, instanceId: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, InstanceId | Artifacts>> =>
    Effect.serviceOption(ArtifactStore).pipe(
      Effect.map(Option.getOrElse(createArtifactStore)),
      Effect.flatMap((store) =>
        effect.pipe(
          Effect.provideService(Artifacts, makeScopedArtifacts(store, fqn)),
          Effect.provideService(InstanceId, instanceId),
        ),
      ),
    ) as Effect.Effect<A, E, Exclude<R, InstanceId | Artifacts>>;

export class DeleteResourceHasDownstreamDependencies extends Data.TaggedError(
  "DeleteResourceHasDownstreamDependencies",
)<{
  message: string;
  resourceId: string;
  dependencies: string[];
}> {}

export class UnsatisfiedResourceCycle extends Data.TaggedError(
  "UnsatisfiedResourceCycle",
)<{
  message: string;
  cycle: string[];
  missingPrecreate: string[];
}> {}

// TODO(sam): compare props
// oldBinding.props !== newBinding.props;

/**
 * Print a plan in a human-readable format that shows the graph topology.
 */
export const printPlan = (plan: Plan): string => {
  const lines: string[] = [];
  const allNodes = { ...plan.resources, ...plan.deletions };

  // Build reverse mapping: upstream -> downstream
  const upstreamMap: Record<string, string[]> = {};
  for (const [id] of Object.entries(allNodes)) {
    upstreamMap[id] = [];
  }
  for (const [id, node] of Object.entries(allNodes)) {
    if (!node) continue;
    for (const downstreamId of node.state?.downstream ?? []) {
      if (upstreamMap[downstreamId]) {
        upstreamMap[downstreamId].push(id);
      }
    }
  }

  // Action symbols
  const actionSymbol = (action: string) => {
    switch (action) {
      case "create":
        return "+";
      case "update":
        return "~";
      case "delete":
        return "-";
      case "replace":
        return "±";
      case "noop":
        return "=";
      default:
        return "?";
    }
  };

  // Print header
  lines.push(
    "╔════════════════════════════════════════════════════════════════╗",
  );
  lines.push(
    "║                           PLAN                                 ║",
  );
  lines.push(
    "╠════════════════════════════════════════════════════════════════╣",
  );
  lines.push(
    "║ Legend: + create, ~ update, - delete, ± replace, = noop,       ║",
  );
  lines.push(
    "║         λ run task, · skip task                                ║",
  );
  lines.push(
    "╚════════════════════════════════════════════════════════════════╝",
  );
  lines.push("");

  // Print resources section
  lines.push(
    "┌─ Resources ────────────────────────────────────────────────────┐",
  );
  const resourceIds = Object.keys(plan.resources).sort();
  for (const id of resourceIds) {
    const node = plan.resources[id];
    const symbol = actionSymbol(node.action);
    const type = node.resource?.type ?? "unknown";
    const downstream = node.state?.downstream?.length
      ? ` → [${node.state?.downstream.join(", ")}]`
      : "";
    lines.push(`│ [${symbol}] ${id} (${type})${downstream}`);
  }
  if (resourceIds.length === 0) {
    lines.push("│ (none)");
  }
  lines.push(
    "└────────────────────────────────────────────────────────────────┘",
  );
  lines.push("");

  // Print tasks section
  lines.push(
    "┌─ Tasks ────────────────────────────────────────────────────────┐",
  );
  const taskIds = Object.keys(plan.actions ?? {}).sort();
  for (const id of taskIds) {
    const node = plan.actions[id];
    const symbol = node.action === "run" ? "λ" : "·";
    const type = node.def.Type;
    const downstream = node.downstream.length
      ? ` → [${node.downstream.join(", ")}]`
      : "";
    lines.push(`│ [${symbol}] ${id} (${type})${downstream}`);
  }
  if (taskIds.length === 0) {
    lines.push("│ (none)");
  }
  lines.push(
    "└────────────────────────────────────────────────────────────────┘",
  );
  lines.push("");

  // Print deletions section
  lines.push(
    "┌─ Deletions ────────────────────────────────────────────────────┐",
  );
  const deletionIds = Object.keys(plan.deletions).sort();
  for (const id of deletionIds) {
    const node = plan.deletions[id]!;
    const type = node.resource?.Type ?? "unknown";
    const downstream = node.state.downstream?.length
      ? ` → [${node.state.downstream.join(", ")}]`
      : "";
    lines.push(`│ [-] ${id} (${type})${downstream}`);
  }
  const taskDeletionIds = Object.keys(plan.actionDeletions ?? {}).sort();
  for (const id of taskDeletionIds) {
    const node = plan.actionDeletions[id]!;
    lines.push(`│ [-] ${id} (${node.def.Type}) [action]`);
  }
  if (deletionIds.length === 0 && taskDeletionIds.length === 0) {
    lines.push("│ (none)");
  }
  lines.push(
    "└────────────────────────────────────────────────────────────────┘",
  );
  lines.push("");

  return lines.join("\n");
};
