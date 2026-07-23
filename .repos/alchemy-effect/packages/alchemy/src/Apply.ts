import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Simplify } from "effect/Types";
import {
  Artifacts,
  ArtifactStore,
  createArtifactStore,
  ensureArtifactStore,
  makeScopedArtifacts,
} from "./Artifacts.ts";
import {
  type PlanStatusSession,
  type ScopedPlanStatusSession,
  Cli,
} from "./Cli/Cli.ts";
import type { ApplyStatus } from "./Cli/Event.ts";
import { havePropsChanged } from "./Diff.ts";
import { toFqn } from "./FQN.ts";
import type { Input } from "./Input.ts";
import { generateInstanceId, InstanceId } from "./InstanceId.ts";
import * as Output from "./Output.ts";
import {
  type ActionApply,
  type Apply,
  type Delete,
  type Plan,
} from "./Plan.ts";
import { findProviderByType } from "./Provider.ts";
import type { ResourceBinding } from "./Resource.ts";
import { Stack } from "./Stack.ts";
import { Stage } from "./Stage.ts";
import {
  type ActionState,
  type CreatedResourceState,
  type CreatingResourceState,
  type DeletingResourceState,
  type PersistedState,
  type RanActionState,
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  type RunningActionState,
  type UpdatedResourceState,
  type UpdatingReourceState,
  State,
  StateStoreError,
} from "./State/index.ts";
import { type ResourceOp, recordResourceOp } from "./Telemetry/Metrics.ts";
import { hashInput } from "./Util/hash.ts";

export type ApplyEffect<
  P extends Plan,
  Err = never,
  Req = never,
> = Effect.Effect<
  {
    [k in keyof AppliedPlan<P>]: AppliedPlan<P>[k];
  },
  Err,
  Req
>;

export type AppliedPlan<P extends Plan> = {
  [id in keyof P["resources"]]: P["resources"][id] extends
    | Delete
    | undefined
    | never
    ? never
    : Simplify<P["resources"][id]["resource"]["attr"]>;
};

interface ResourceTracker {
  output: any;
  props: any;
  bindings: ResourceBinding[];
  instanceId: string;
}

const provideLifecycleScope =
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

/**
 * Instruments a single provider lifecycle call with an OTel span
 * (`provider.<op>`), the resource counter / duration histogram, and the
 * scoped artifacts/instance services normally supplied by
 * {@link provideLifecycleScope}.
 *
 * This is the only call site through which provider lifecycle methods
 * are dispatched, so wrapping it here gives us a fully-instrumented
 * toolchain without touching any individual provider implementation.
 */
const instrumentLifecycle =
  (
    op: ResourceOp,
    fqn: string,
    resourceType: string,
    logicalId: string,
    instanceId: string,
  ) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, InstanceId | Artifacts>> =>
    effect.pipe(
      provideLifecycleScope(fqn, instanceId),
      recordResourceOp(resourceType, op),
      Effect.withSpan(`provider.${op}`, {
        attributes: {
          "alchemy.resource.fqn": fqn,
          "alchemy.resource.type": resourceType,
          "alchemy.resource.logical_id": logicalId,
          "alchemy.resource.instance_id": instanceId,
          "alchemy.resource.op": op,
        },
      }),
    );

export const apply = <P extends Plan>(
  plan: P,
): Effect.Effect<
  Input.Resolve<P["output"]>,
  Output.InvalidReferenceError | Output.MissingSourceError | StateStoreError,
  Cli | State | Stack | Stage
> =>
  Effect.gen(function* () {
    const cli = yield* Cli;
    const session = yield* cli.startApplySession(plan);
    const state = yield* yield* State;
    const stack = yield* Stack;
    const stage = yield* Stage;
    const stackName = stack.name;

    const tracker: Record<string, ResourceTracker> = {};
    const terminalStatuses = new Map<
      string,
      {
        id: string;
        type: string;
        status: Extract<ApplyStatus, "created" | "updated" | "ran" | "skipped">;
      }
    >();

    yield* executePlan(
      plan,
      tracker,
      terminalStatuses,
      session,
      state,
      stackName,
      stage,
    );

    // TODO(sam): support roll back to previous state if errors occur during expansion
    // -> RISK: some UPDATEs may not be reversible (i.e. trigger replacements)
    // TODO(sam): should pivot be done separately? E.g shift traffic?

    yield* collectGarbage(plan, session);

    yield* converge(
      plan,
      tracker,
      terminalStatuses,
      session,
      state,
      stackName,
      stage,
    );

    yield* Effect.forEach(
      Array.from(terminalStatuses.values()),
      ({ id, type, status }) =>
        session.emit({ kind: "status-change", id, type, status }),
      { concurrency: "unbounded" },
    );

    yield* session.done();

    if (!plan.output) {
      return undefined;
    }

    const outputs = Object.fromEntries(
      Object.entries(tracker).map(([fqn, t]) => [fqn, t.output]),
    );
    const resolved = yield* Output.evaluate(plan.output, outputs);

    // Persist the stack's evaluated outputs so cross-stack references
    // (`yield* OtherStack` / `OtherStack.stage.<name>` / `Output.stackRef`)
    // can read them back out of the state store.
    yield* state.setOutput({ stack: stackName, stage, value: resolved });

    return resolved;
  }).pipe(
    ensureArtifactStore,
    Effect.withSpan("apply", {
      attributes: {
        "alchemy.resources.count": Object.keys(plan.resources).length,
        "alchemy.deletions.count": Object.keys(plan.deletions).length,
      },
    }),
  );

// ── Phase 1: concurrent initial execution ──────────────────────────────────
//
// Each resource gets a Deferred<void> that signals "I have some output
// available in `tracker`." Resources with `precreate` signal early so that
// downstream resources can resolve stable identifiers without deadlocking.
// The actual output lives in the mutable `tracker` map, not in the Deferred.

const executePlan = Effect.fnUntraced(function* (
  plan: Plan,
  tracker: Record<string, ResourceTracker>,
  terminalStatuses: Map<
    string,
    {
      id: string;
      type: string;
      status: Extract<ApplyStatus, "created" | "updated" | "ran" | "skipped">;
    }
  >,
  session: PlanStatusSession,
  state: {
    set: <V extends PersistedState>(req: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) => Effect.Effect<V, StateStoreError, never>;
  },
  stackName: string,
  stage: string,
) {
  // Resources and tasks share the same FQN namespace and DAG, so the
  // scheduler tracks them together. Each entry gets a single Deferred that
  // signals "my output is available in `tracker`."
  const allNodes: Record<string, Apply | ActionApply> = {
    ...plan.resources,
    ...plan.actions,
  };

  const ready = Object.fromEntries(
    yield* Effect.all(
      Object.keys(allNodes).map((fqn) =>
        Effect.map(Deferred.make<void>(), (d) => [fqn, d] as const),
      ),
    ),
  ) as Record<string, Deferred.Deferred<void>>;

  // `readyStable` fires only when a node has reached its TERMINAL output —
  // resources after `reconcile`, tasks after the body completes. Resource
  // precreate stubs do NOT signal `readyStable`, so any consumer that
  // requires stable inputs (e.g. Tasks) waits past the precreate phase.
  const readyStable = Object.fromEntries(
    yield* Effect.all(
      Object.keys(allNodes).map((fqn) =>
        Effect.map(Deferred.make<void>(), (d) => [fqn, d] as const),
      ),
    ),
  ) as Record<string, Deferred.Deferred<void>>;

  const getOutputs = (): Record<string, any> =>
    Object.fromEntries(
      Object.entries(tracker).map(([fqn, t]) => [fqn, t.output]),
    );

  const waitForDeps = (fqns: string[]) =>
    Effect.all(
      fqns
        .filter((fqn) => fqn in ready)
        .map((fqn) =>
          // Non-cycle upstreams must be observed at their TERMINAL output
          // (`readyStable`), not their early precreate signal (`ready`). This
          // is what makes a failed upstream actually interrupt its downstream:
          // a resource with `precreate` resolves `ready` before its real
          // `reconcile` runs, so a downstream waiting on `ready` would proceed
          // (and even finish) even though the upstream's reconcile later
          // failed. Waiting on `readyStable` means the downstream's
          // `waitForDeps` short-circuits with the upstream's failure cause.
          //
          // Cycle members are the exception: peers in an SCC depend on each
          // other, so they must rendezvous on the early `ready`/precreate
          // signal to break the deadlock. Phase 3 (`converge`) re-runs them
          // against final outputs once the cycle settles.
          plan.cycleMembers.has(fqn)
            ? Deferred.await(ready[fqn])
            : Deferred.await(readyStable[fqn]),
        ),
      { concurrency: "unbounded" },
    );

  const waitForStableDeps = (fqns: string[]) =>
    Effect.all(
      fqns
        .filter((fqn) => fqn in readyStable)
        .map((fqn) => Deferred.await(readyStable[fqn])),
      { concurrency: "unbounded" },
    );

  const failures: LifecycleFailure[] = [];

  yield* Effect.all(
    Object.entries(allNodes).map(([fqn, node]) =>
      (node as ActionApply).kind === "action"
        ? executeActionNode(
            fqn,
            node as ActionApply,
            tracker,
            ready,
            readyStable,
            terminalStatuses,
            session,
            state,
            stackName,
            stage,
            getOutputs,
            waitForStableDeps,
            failures,
          )
        : executeNode(
            fqn,
            node as Apply,
            tracker,
            ready,
            readyStable,
            terminalStatuses as any,
            session,
            state,
            stackName,
            stage,
            getOutputs,
            waitForDeps,
            failures,
            plan.cycleMembers.has(fqn),
          ),
    ),
    { concurrency: "unbounded" },
  );

  if (failures.length > 0) {
    // Aggregate every collected lifecycle failure into a single parallel Cause
    // so the apply ends with one combined error containing every distinct
    // failure / defect that occurred across the concurrent fibers.
    yield* Effect.failCause(failures.map((f) => f.cause).reduce(Cause.combine));
  }
});

interface LifecycleFailure {
  fqn: string;
  logicalId: string;
  type: string;
  cause: Cause.Cause<unknown>;
}

const executeNode = (
  fqn: string,
  node: Apply,
  tracker: Record<string, ResourceTracker>,
  ready: Record<string, Deferred.Deferred<void>>,
  readyStable: Record<string, Deferred.Deferred<void>>,
  terminalStatuses: Map<
    string,
    {
      id: string;
      type: string;
      status: Extract<ApplyStatus, "created" | "updated">;
    }
  >,
  session: PlanStatusSession,
  state: {
    set: <V extends ResourceState>(req: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) => Effect.Effect<V, StateStoreError, never>;
  },
  stackName: string,
  stage: string,
  getOutputs: () => Record<string, any>,
  waitForDeps: (fqns: string[]) => Effect.Effect<void[], never, never>,
  failures: LifecycleFailure[],
  inCycle: boolean,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const logicalId = node.resource.LogicalId;
    const namespace = node.resource.Namespace;

    const commit = <S extends ResourceState>(value: Omit<S, "namespace">) =>
      state.set({
        stack: stackName,
        stage,
        fqn,
        value: { ...value, namespace } as S,
      });

    const scopedSession = {
      ...session,
      note: (note: string) =>
        session.emit({ id: logicalId, kind: "annotate", message: note }),
    } satisfies ScopedPlanStatusSession;

    const report = (status: ApplyStatus) =>
      session.emit({
        kind: "status-change",
        id: logicalId,
        type: node.resource.Type,
        status,
      });

    const markTerminal = (status: "created" | "updated") =>
      Effect.gen(function* () {
        terminalStatuses.set(fqn, {
          id: logicalId,
          type: node.resource.Type,
          status,
        });
        // Emit immediately so the CLI surfaces the terminal status as soon
        // as the resource is actually done — instead of batching every
        // resource's "created"/"updated" event to the end of apply(), which
        // makes long-running siblings appear stuck in "creating" until the
        // entire deploy finishes.
        //
        // Cycle members are exempt: their initial pass produces an
        // intermediate result that Phase 3 (`converge`) will overwrite once
        // the SCC reaches a fixed point. Emitting "created"/"updated" here
        // would surface that intermediate state to the CLI before the real
        // terminal status is known. Their final status is flushed from
        // `terminalStatuses` after `converge` completes.
        if (inCycle) return;
        yield* session.emit({
          kind: "status-change",
          id: logicalId,
          type: node.resource.Type,
          status,
        });
      });

    const signalReady = Deferred.succeed(ready[fqn], void 0);
    // Signal only after reconcile completes — never during precreate. Tasks
    // (and any other consumer that calls `waitForStableDeps`) block on this
    // so they observe the resource's final attrs rather than a stub.
    const signalReadyStable = Deferred.succeed(readyStable[fqn], void 0);

    const storeAndSignal = (t: ResourceTracker) =>
      Effect.gen(function* () {
        tracker[fqn] = t;
        yield* signalReady;
      });

    // ── noop ──

    if (node.action === "noop") {
      // No work to do — the persisted attr is already stable.
      yield* signalReadyStable;
      yield* storeAndSignal({
        output: node.state.attr,
        props: node.state.props,
        bindings: node.state.bindings ?? [],
        instanceId: node.state.instanceId,
      });
      return;
    }

    const allUpstreamFqns = () => {
      const propDeps = Object.keys(Output.resolveUpstream(node.props));
      const bindingDeps = Object.keys(Output.resolveUpstream(node.bindings));
      return [...new Set([...propDeps, ...bindingDeps])];
    };

    // ── instance ID ──

    const instanceId = yield* Effect.gen(function* () {
      if (node.action === "create" && !node.state?.instanceId) {
        const id = yield* generateInstanceId();
        yield* commit<CreatingResourceState>({
          status: "creating",
          fqn,
          logicalId,
          instanceId: id,
          downstream: node.downstream,
          props: node.props,
          providerVersion: node.provider.version ?? 0,
          resourceType: node.resource.Type,
          bindings: excludeDeletedBindings(node.bindings),
          removalPolicy: node.resource.RemovalPolicy,
        });
        return id;
      } else if (node.action === "replace") {
        if (
          (node.state.status === "replaced" ||
            node.state.status === "replacing") &&
          !node.restart
        ) {
          // Ordinary replacement recovery keeps using the same replacement
          // generation. Only `restart` is allowed to mint a new instance id.
          return node.state.instanceId;
        }
        const id = yield* generateInstanceId();
        yield* commit<ReplacingResourceState>({
          status: "replacing",
          fqn,
          logicalId,
          instanceId: id,
          downstream: node.downstream,
          props: node.props,
          providerVersion: node.provider.version ?? 0,
          resourceType: node.resource.Type,
          bindings: excludeDeletedBindings(node.bindings),
          old: node.state,
          deleteFirst: node.deleteFirst,
          removalPolicy: node.resource.RemovalPolicy,
        });
        return id;
      } else if (node.state?.instanceId) {
        return node.state.instanceId;
      }
      return yield* Effect.die(
        `Instance ID not found for resource '${logicalId}' and action is '${node.action}'`,
      );
    });

    // ── lifecycle ──

    yield* Effect.gen(function* () {
      // ── create ──
      if (node.action === "create") {
        if (!node.state) {
          // First persistence point for a brand new logical resource. Once this is
          // written, retries know they should resume creation instead of planning
          // another fresh create from scratch.
          yield* commit<CreatingResourceState>({
            status: "creating",
            fqn,
            logicalId,
            instanceId,
            resourceType: node.resource.Type,
            props: node.props,
            attr: undefined,
            providerVersion: node.provider.version ?? 0,
            bindings: excludeDeletedBindings(node.bindings),
            downstream: node.downstream,
            removalPolicy: node.resource.RemovalPolicy,
          });
        }

        let attr: any = node.state?.attr;

        if (attr !== undefined) {
          // Precreate/read may already have produced a usable output snapshot. Publish
          // it early so downstream resources can start resolving against it.
          yield* storeAndSignal({
            output: attr,
            props: {},
            bindings: [],
            instanceId,
          });
        }

        if (node.provider.precreate && attr === undefined) {
          // Some resources need a placeholder physical resource before their real
          // create can finish. Persist that stub so downstream evaluation can proceed.
          yield* report("pre-creating");
          attr = yield* node.provider
            .precreate({
              id: logicalId,
              news: node.props,
              session: scopedSession,
              instanceId,
              bindings: excludeDeletedBindings(node.bindings),
            })
            .pipe(
              instrumentLifecycle(
                "precreate",
                fqn,
                node.resource.Type,
                logicalId,
                instanceId,
              ),
            );
          yield* commit<CreatingResourceState>({
            status: "creating",
            fqn,
            logicalId,
            instanceId,
            resourceType: node.resource.Type,
            props: node.props,
            attr,
            providerVersion: node.provider.version ?? 0,
            bindings: excludeDeletedBindings(node.bindings),
            downstream: node.downstream,
            removalPolicy: node.resource.RemovalPolicy,
          });
          yield* storeAndSignal({
            output: attr,
            props: {},
            bindings: [],
            instanceId,
          });
        }

        // While we're waiting on upstream outputs the resource isn't actually
        // creating anything yet — surface that as "pending" so the CLI doesn't
        // look stuck in "creating" for slow-upstream deploys.
        yield* report("pending");

        // Create runs against fully resolved upstream outputs and bindings, not the
        // raw Output expressions stored in the plan.
        yield* waitForDeps(allUpstreamFqns());

        yield* report("creating");
        const outputs = getOutputs();

        const news = (yield* Output.evaluate(node.props, outputs)) as Record<
          string,
          any
        >;

        const bindingOutputs = excludeDeletedBindings(
          yield* Output.evaluate(node.bindings, outputs),
        );

        attr = yield* node.provider
          .reconcile({
            id: logicalId,
            news,
            instanceId,
            bindings: bindingOutputs,
            session: scopedSession,
            olds: undefined,
            output: attr,
          })
          .pipe(
            instrumentLifecycle(
              "create",
              fqn,
              node.resource.Type,
              logicalId,
              instanceId,
            ),
          );

        yield* commit<CreatedResourceState>({
          status: "created",
          fqn,
          logicalId,
          instanceId,
          resourceType: node.resource.Type,
          props: news,
          attr,
          bindings: excludeDeletedBindings(node.bindings),
          providerVersion: node.provider.version ?? 0,
          downstream: node.downstream,
          removalPolicy: node.resource.RemovalPolicy,
        });

        tracker[fqn] = {
          output: attr,
          props: news,
          bindings: bindingOutputs,
          instanceId,
        };
        yield* signalReady;
        yield* signalReadyStable;

        yield* markTerminal("created");
        return;
      }

      // ── update ──
      if (node.action === "update") {
        // Cycle members publish their previous live attr *before* waiting on
        // upstreams so the SCC can converge — peers in the cycle would
        // otherwise deadlock waiting on each other. Phase 3 (`converge`)
        // re-runs each peer's update against fresh outputs once everyone
        // has settled.
        //
        // Linear (DAG) update nodes skip this entirely and simply wait for
        // fresh upstream outputs, mirroring the create flow. This is the
        // important property: a downstream of a non-cycle update never
        // observes the upstream's stale attr, which prevents wasted/
        // destructive intermediate updates (e.g. a Worker deploying with
        // stale Build assets).
        if (inCycle) {
          yield* storeAndSignal({
            output: node.state.attr,
            props: node.state.props,
            bindings: node.state.bindings ?? [],
            instanceId,
          });
        }

        // See create-flow note: while we're waiting on upstream outputs
        // this resource isn't actually updating yet.
        yield* report("pending");
        yield* waitForDeps(allUpstreamFqns());
        const outputs = getOutputs();

        const news = (yield* Output.evaluate(node.props, outputs)) as Record<
          string,
          any
        >;

        yield* node.state.status === "replaced"
          ? commit<ReplacedResourceState>({
              // Keep the replacement wrapper intact while changing the live
              // replacement props; GC still has older generations to delete.
              ...node.state,
              attr: node.state.attr,
              props: news,
            })
          : commit<UpdatingReourceState>({
              // For ordinary updates we snapshot the previously stable props/attrs
              // once, so retries can continue from the same baseline.
              status: "updating",
              fqn,
              logicalId,
              instanceId,
              resourceType: node.resource.Type,
              props: news,
              attr: node.state.attr,
              providerVersion: node.provider.version ?? 0,
              bindings: excludeDeletedBindings(node.bindings),
              downstream: node.downstream,
              old:
                node.state.status === "updating" ? node.state.old : node.state,
              removalPolicy: node.resource.RemovalPolicy,
            });

        yield* report("updating");

        const previousProps =
          node.state.status === "created" ||
          node.state.status === "updated" ||
          node.state.status === "replaced"
            ? node.state.props
            : node.state.old.props;

        // Providers receive the resolved binding payload for this exact pass, while
        // `previousProps` tells them what state the live resource is being updated from.
        const bindingOutputs = excludeDeletedBindings(
          yield* Output.evaluate(node.bindings, outputs),
        );

        const attr = yield* node.provider
          .reconcile({
            id: logicalId,
            news,
            instanceId,
            bindings: bindingOutputs,
            session: scopedSession,
            olds: previousProps,
            output: node.state.attr,
          })
          .pipe(
            instrumentLifecycle(
              "update",
              fqn,
              node.resource.Type,
              logicalId,
              instanceId,
            ),
          );

        if (node.state.status === "replaced") {
          yield* commit<ReplacedResourceState>({
            // The live replacement changed, but cleanup of older generations still
            // has to continue afterwards.
            ...node.state,
            attr,
            props: news,
          });
        } else {
          yield* commit<UpdatedResourceState>({
            status: "updated",
            fqn,
            logicalId,
            instanceId,
            resourceType: node.resource.Type,
            props: news,
            attr,
            bindings: excludeDeletedBindings(node.bindings),
            providerVersion: node.provider.version ?? 0,
            downstream: node.downstream,
            removalPolicy: node.resource.RemovalPolicy,
          });
        }

        tracker[fqn] = {
          output: attr,
          props: news,
          bindings: bindingOutputs,
          instanceId,
        };
        // Signal here for the linear (non-cycle) path. For in-cycle updates
        // the deferred has already been resolved by the early `storeAndSignal`
        // above and `signalReady` is a no-op the second time.
        yield* signalReady;
        yield* signalReadyStable;

        yield* markTerminal("updated");
        return;
      }

      // ── replace ──
      if (node.action === "replace") {
        if (node.state.status === "replaced" && !node.restart) {
          // The replacement already exists; this pass only needs GC to clean up
          // older generations, so expose the current replacement and stop here.
          tracker[fqn] = {
            output: node.state.attr,
            props: node.state.props,
            bindings: node.state.bindings ?? [],
            instanceId,
          };
          yield* signalReady;
          yield* signalReadyStable;
          yield* markTerminal("created");
          return;
        }

        let replState: ReplacingResourceState;
        if (node.state.status !== "replacing" || node.restart) {
          // `restart` deliberately nests the previous top-level replacement state
          // into `old`, creating a new outer generation to replace it.
          replState = yield* commit<ReplacingResourceState>({
            status: "replacing",
            fqn,
            logicalId,
            instanceId,
            resourceType: node.resource.Type,
            props: node.props,
            bindings: excludeDeletedBindings(node.bindings),
            attr: undefined,
            providerVersion: node.provider.version ?? 0,
            deleteFirst: node.deleteFirst,
            old: node.state,
            downstream: node.downstream,
            removalPolicy: node.resource.RemovalPolicy,
          });
        } else {
          // Resume the same replacement generation after an interrupted apply.
          replState = node.state;
        }

        let attr: any = replState.attr;

        if (attr !== undefined) {
          // If precreate already ran, expose that intermediate output immediately so
          // downstream resources can resolve against the same in-flight replacement.
          yield* storeAndSignal({
            output: attr,
            props: {},
            bindings: [],
            instanceId,
          });
        }

        if (node.provider.precreate && attr === undefined) {
          yield* report("pre-creating");
          attr = yield* node.provider
            .precreate({
              id: logicalId,
              news: node.props,
              session: scopedSession,
              instanceId,
              bindings: excludeDeletedBindings(node.bindings),
            })
            .pipe(
              instrumentLifecycle(
                "precreate",
                fqn,
                node.resource.Type,
                logicalId,
                instanceId,
              ),
            );
          yield* commit<ReplacingResourceState>({
            status: "replacing",
            fqn,
            logicalId,
            instanceId,
            resourceType: node.resource.Type,
            props: node.props,
            attr,
            providerVersion: node.provider.version ?? 0,
            bindings: excludeDeletedBindings(node.bindings),
            downstream: node.downstream,
            old: replState.old,
            deleteFirst: node.deleteFirst,
            removalPolicy: node.resource.RemovalPolicy,
          });
          yield* storeAndSignal({
            output: attr,
            props: {},
            bindings: [],
            instanceId,
          });
        }

        // See create-flow note: while we're waiting on upstream outputs
        // the replacement isn't actually being created yet.
        yield* report("pending");

        // Replacement create is evaluated exactly like create, but against the new
        // generation's instance id and with the previous generations preserved in `old`.
        yield* waitForDeps(allUpstreamFqns());

        yield* report("creating replacement");
        const outputs = getOutputs();

        const news = (yield* Output.evaluate(node.props, outputs)) as Record<
          string,
          any
        >;

        const bindingOutputs = excludeDeletedBindings(
          yield* Output.evaluate(node.bindings, outputs),
        );

        attr = yield* node.provider
          .reconcile({
            id: logicalId,
            news,
            instanceId,
            bindings: bindingOutputs,
            session: scopedSession,
            olds: undefined,
            output: attr,
          })
          .pipe(
            instrumentLifecycle(
              "create",
              fqn,
              node.resource.Type,
              logicalId,
              instanceId,
            ),
          );

        yield* commit<ReplacedResourceState>({
          // Creation of the new generation succeeded; from here on the only remaining
          // work is draining the old chain via garbage collection.
          status: "replaced",
          fqn,
          logicalId,
          instanceId,
          resourceType: node.resource.Type,
          props: news,
          attr,
          providerVersion: node.provider.version ?? 0,
          bindings: excludeDeletedBindings(node.bindings),
          downstream: node.downstream,
          // Preserve the remaining backlog exactly as-is. GC is responsible for
          // popping one generation at a time until the chain is exhausted.
          old: replState.old,
          deleteFirst: node.deleteFirst,
          removalPolicy: node.resource.RemovalPolicy,
        });

        tracker[fqn] = {
          output: attr,
          props: news,
          bindings: bindingOutputs,
          instanceId,
        };
        yield* signalReady;
        yield* signalReadyStable;

        // Keep progress anchored to the live replacement while GC drains the
        // previous generation(s) in the background.
        yield* markTerminal("created");
        return;
      }

      // @ts-expect-error - node is never, this should be unreachable
      return yield* Effect.die(`Unknown action: ${node.action}`);
    });
  }).pipe(
    Effect.catchCause((cause) =>
      // Record the failure, propagate it to any downstream resources waiting on
      // our Deferred (so their waitForDeps short-circuits instead of deadlocking),
      // emit a "fail" status to the session, and resolve to void so Effect.all
      // does not interrupt sibling fibers. The aggregated cause is raised at
      // the end of executePlan.
      Effect.gen(function* () {
        failures.push({
          fqn,
          logicalId: node.resource.LogicalId,
          type: node.resource.Type,
          cause,
        });
        yield* Deferred.failCause(ready[fqn], cause as Cause.Cause<never>);
        yield* Deferred.failCause(
          readyStable[fqn],
          cause as Cause.Cause<never>,
        );
        yield* session.emit({
          kind: "status-change",
          id: node.resource.LogicalId,
          type: node.resource.Type,
          status: "fail",
        });
      }),
    ),
    Effect.withSpan("apply.resource", {
      attributes: {
        "alchemy.resource.fqn": fqn,
        "alchemy.resource.type": node.resource.Type,
        "alchemy.resource.logical_id": node.resource.LogicalId,
        "alchemy.resource.action": node.action,
      },
    }),
  ) as Effect.Effect<void, never, never>;

// ── Task execution ─────────────────────────────────────────────────────────
//
// Tasks slot into the same scheduler as resources. They have no provider
// lifecycle — just a single Effect that runs when inputs change (or when
// `--force` is set). The output value is written to `tracker[fqn].output`
// so downstream Output evaluation works identically to resource attrs.

const executeActionNode = (
  fqn: string,
  node: ActionApply,
  tracker: Record<string, ResourceTracker>,
  ready: Record<string, Deferred.Deferred<void>>,
  readyStable: Record<string, Deferred.Deferred<void>>,
  terminalStatuses: Map<
    string,
    {
      id: string;
      type: string;
      status: Extract<ApplyStatus, "created" | "updated" | "ran" | "skipped">;
    }
  >,
  session: PlanStatusSession,
  state: {
    set: <V extends PersistedState>(req: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) => Effect.Effect<V, StateStoreError, never>;
  },
  stackName: string,
  stage: string,
  getOutputs: () => Record<string, any>,
  waitForDeps: (fqns: string[]) => Effect.Effect<void[], never, never>,
  failures: LifecycleFailure[],
): Effect.Effect<void, never, any> =>
  Effect.gen(function* () {
    const task = node.def;
    const logicalId = task.LogicalId;
    const namespace = task.Namespace;

    const commit = <S extends ActionState>(value: Omit<S, "namespace">) =>
      state.set({
        stack: stackName,
        stage,
        fqn,
        value: { ...value, namespace } as S,
      });

    const report = (status: ApplyStatus) =>
      session.emit({
        kind: "status-change",
        id: logicalId,
        type: task.Type,
        status,
      });

    const signalReady = Deferred.succeed(ready[fqn], void 0);
    const signalReadyStable = Deferred.succeed(readyStable[fqn], void 0);

    if (node.action === "noop") {
      tracker[fqn] = {
        output: node.state.output,
        props: { __input: node.state.input },
        bindings: [],
        instanceId: fqn,
      };
      yield* signalReady;
      yield* signalReadyStable;
      terminalStatuses.set(fqn, {
        id: logicalId,
        type: task.Type,
        status: "skipped",
      });
      yield* report("skipped");
      return;
    }

    // ── run ──
    // Tasks wait on `waitForStableDeps` (post-reconcile attrs) for their
    // upstreams, which is often the slowest dep chain in the deploy.
    // Surface that as "pending" instead of having the task show no status
    // until its run actually starts.
    yield* report("pending");
    yield* waitForDeps(
      Object.keys(Output.resolveUpstream(node.input)).filter(
        (f) => f in readyStable,
      ),
    );

    const outputs = getOutputs();
    const resolvedInput = (yield* Output.evaluate(node.input, outputs)) as any;
    const inputHashValue = yield* hashInput(resolvedInput);

    yield* commit<RunningActionState>({
      kind: "action",
      status: "running",
      fqn,
      logicalId,
      actionType: task.Type,
      inputHash: inputHashValue,
      input: resolvedInput,
      downstream: node.downstream,
    });
    yield* report("running");

    const result = yield* task.Run(resolvedInput);

    yield* commit<RanActionState>({
      kind: "action",
      status: "ran",
      fqn,
      logicalId,
      actionType: task.Type,
      inputHash: inputHashValue,
      input: resolvedInput,
      output: result,
      downstream: node.downstream,
    });

    tracker[fqn] = {
      output: result,
      props: { __input: resolvedInput },
      bindings: [],
      instanceId: fqn,
    };
    yield* signalReady;
    yield* signalReadyStable;
    terminalStatuses.set(fqn, {
      id: logicalId,
      type: task.Type,
      status: "ran",
    });
    yield* report("ran");
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        failures.push({
          fqn,
          logicalId: node.def.LogicalId,
          type: node.def.Type,
          cause,
        });
        yield* Deferred.failCause(ready[fqn], cause as Cause.Cause<never>);
        yield* Deferred.failCause(
          readyStable[fqn],
          cause as Cause.Cause<never>,
        );
        yield* session.emit({
          kind: "status-change",
          id: node.def.LogicalId,
          type: node.def.Type,
          status: "fail",
        });
      }),
    ),
    Effect.withSpan("apply.action", {
      attributes: {
        "alchemy.action.fqn": fqn,
        "alchemy.action.type": node.def.Type,
        "alchemy.action.logical_id": node.def.LogicalId,
        "alchemy.action.verb": node.action,
      },
    }),
  ) as Effect.Effect<void, never, any>;

// ── Phase 3: imperative convergence loop ───────────────────────────────────
//
// After the initial concurrent pass, some resources may have been created
// with stale upstream values (e.g. a precreate stub instead of the final
// output). Walk the plan and re-evaluate each resource's props/bindings
// against the current tracker outputs. Call provider.reconcile for any
// resource whose resolved inputs differ from what it was last applied with.
// Repeat until no resource needs updating.

const converge = Effect.fnUntraced(function* (
  plan: Plan,
  tracker: Record<string, ResourceTracker>,
  terminalStatuses: Map<
    string,
    {
      id: string;
      type: string;
      status: Extract<ApplyStatus, "created" | "updated" | "ran" | "skipped">;
    }
  >,
  session: PlanStatusSession,
  state: {
    set: <V extends PersistedState>(req: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) => Effect.Effect<V, StateStoreError, never>;
  },
  stackName: string,
  stage: string,
) {
  for (;;) {
    let anyUpdated = false;

    for (const [fqn, node] of Object.entries(plan.resources)) {
      if (node.action === "noop") continue;
      if (!tracker[fqn]) continue;

      const outputs = Object.fromEntries(
        Object.entries(tracker).map(([k, t]) => [k, t.output]),
      );

      const newProps = (yield* Output.evaluate(node.props, outputs)) as Record<
        string,
        any
      >;

      const newBindings = excludeDeletedBindings(
        yield* Output.evaluate(node.bindings, outputs),
      );

      const oldProps = tracker[fqn].props;
      const oldBindings = tracker[fqn].bindings;

      const propsChanged = havePropsChanged(oldProps, newProps);
      const bindingsChanged =
        JSON.stringify(oldBindings) !== JSON.stringify(newBindings);

      if (!propsChanged && !bindingsChanged) continue;

      anyUpdated = true;

      const logicalId = node.resource.LogicalId;
      const namespace = node.resource.Namespace;
      const instanceId = tracker[fqn].instanceId;

      const scopedSession = {
        ...session,
        note: (note: string) =>
          session.emit({ id: logicalId, kind: "annotate", message: note }),
      } satisfies ScopedPlanStatusSession;

      const attr = yield* node.provider
        .reconcile({
          id: logicalId,
          news: newProps,
          instanceId,
          bindings: newBindings,
          session: scopedSession,
          olds: oldProps,
          output: tracker[fqn].output,
        })
        .pipe(
          instrumentLifecycle(
            "update",
            fqn,
            node.resource.Type,
            logicalId,
            instanceId,
          ),
        );

      tracker[fqn] = {
        output: attr,
        props: newProps,
        bindings: newBindings,
        instanceId,
      };

      yield* state.set({
        stack: stackName,
        stage,
        fqn,
        value: {
          status: "updated",
          fqn,
          logicalId,
          instanceId,
          resourceType: node.resource.Type,
          props: newProps,
          attr,
          providerVersion: node.provider.version ?? 0,
          bindings: excludeDeletedBindings(node.bindings),
          downstream: node.downstream,
          namespace,
          removalPolicy: node.resource.RemovalPolicy,
        } as UpdatedResourceState,
      });

      terminalStatuses.set(fqn, {
        id: logicalId,
        type: node.resource.Type,
        status: "updated",
      });
    }

    // Tasks: re-run when their resolved input drifts vs. the value they
    // last applied with (e.g. an upstream resource produced new attrs in
    // this pass). Skipped (noop) tasks are not re-checked here — their
    // recorded inputHash is authoritative until the next plan.
    for (const [fqn, node] of Object.entries(plan.actions)) {
      if (node.action !== "run") continue;
      if (!tracker[fqn]) continue;

      const outputs = Object.fromEntries(
        Object.entries(tracker).map(([k, t]) => [k, t.output]),
      );
      const newInput = (yield* Output.evaluate(node.input, outputs)) as any;
      const newHash = yield* hashInput(newInput);
      const oldInput = tracker[fqn].props?.__input;
      const oldHash = yield* hashInput(oldInput);
      if (newHash === oldHash) continue;

      anyUpdated = true;

      yield* state.set({
        stack: stackName,
        stage,
        fqn,
        value: {
          kind: "action",
          status: "running",
          fqn,
          logicalId: node.def.LogicalId,
          namespace: node.def.Namespace,
          actionType: node.def.Type,
          inputHash: newHash,
          input: newInput,
          downstream: node.downstream,
        } satisfies RunningActionState,
      });

      const result = yield* node.def.Run(newInput);

      yield* state.set({
        stack: stackName,
        stage,
        fqn,
        value: {
          kind: "action",
          status: "ran",
          fqn,
          logicalId: node.def.LogicalId,
          namespace: node.def.Namespace,
          actionType: node.def.Type,
          inputHash: newHash,
          input: newInput,
          output: result,
          downstream: node.downstream,
        } satisfies RanActionState,
      });

      tracker[fqn] = {
        output: result,
        props: { __input: newInput },
        bindings: [],
        instanceId: fqn,
      };
      terminalStatuses.set(fqn, {
        id: node.def.LogicalId,
        type: node.def.Type,
        status: "ran",
      });
    }

    if (!anyUpdated) break;
  }
});

// ── Phase 2: delete orphans and old replaced resources ─────────────────────

const collectGarbage = Effect.fnUntraced(function* (
  plan: Plan,
  session: PlanStatusSession,
) {
  const state = yield* yield* State;
  const stack = yield* Stack;
  const stackName = stack.name;
  const stage = yield* Stage;

  // Task deletions are pure state drops — no body is invoked. Run them in
  // parallel before resource GC; tasks never have provider-side dependencies
  // to wait on.
  yield* Effect.all(
    Object.entries(plan.actionDeletions ?? {}).map(([fqn, node]) =>
      node === undefined
        ? Effect.void
        : Effect.gen(function* () {
            yield* session.emit({
              kind: "status-change",
              id: node.def.LogicalId,
              type: node.def.Type,
              status: "deleting",
            });
            yield* state.delete({ stack: stackName, stage, fqn });
            yield* session.emit({
              kind: "status-change",
              id: node.def.LogicalId,
              type: node.def.Type,
              status: "deleted",
            });
          }),
    ),
    { concurrency: "unbounded" },
  );

  const deleteGraph = Effect.fnUntraced(function* (
    deletionGraph: Record<string, Delete | ReplacedResourceState | undefined>,
  ) {
    const deletions: {
      [fqn in string]: Effect.Effect<void, StateStoreError, ArtifactStore>;
    } = {};

    const deleteResource = (
      node: Delete | ReplacedResourceState,
      ancestors: ReadonlySet<string> = new Set(),
    ): Effect.Effect<void, StateStoreError, ArtifactStore> =>
      Effect.gen(function* () {
        const isDeleteNode = (
          node: Delete | ReplacedResourceState,
        ): node is Delete => "action" in node;

        const {
          logicalId,
          namespace,
          resourceType,
          instanceId,
          downstream,
          props,
          attr,
          provider,
        } = isDeleteNode(node)
          ? {
              logicalId: node.resource.LogicalId,
              namespace: node.resource.Namespace,
              resourceType: node.resource.Type,
              instanceId: node.state.instanceId,
              downstream: node.downstream,
              props: node.state.props,
              attr: node.state.attr,
              provider: node.provider,
            }
          : {
              logicalId: node.logicalId,
              namespace: node.namespace,
              resourceType: node.old.resourceType,
              instanceId: node.old.instanceId,
              downstream: node.old.downstream,
              props: node.old.props,
              attr: node.old.attr,
              provider: yield* findProviderByType(node.old.resourceType),
            };

        const fqn = toFqn(namespace, logicalId);
        const nextAncestors = new Set(ancestors).add(fqn);

        const commit = <S extends ResourceState>(value: Omit<S, "namespace">) =>
          state.set({
            stack: stackName,
            stage,
            fqn,
            value: { ...value, namespace } as S,
          });

        const report = (status: ApplyStatus) =>
          session.emit({
            kind: "status-change",
            id: logicalId,
            type: resourceType,
            status,
          });

        const scopedSession = {
          ...session,
          note: (note: string) =>
            session.emit({
              id: logicalId,
              kind: "annotate",
              message: note,
            }),
        } satisfies ScopedPlanStatusSession;

        return yield* (deletions[fqn] ??= yield* Effect.cached(
          Effect.gen(function* () {
            yield* Effect.all(
              downstream.map((dep) =>
                dep !== fqn && dep in deletionGraph && !ancestors.has(dep)
                  ? deleteResource(
                      deletionGraph[dep] as Delete | ReplacedResourceState,
                      nextAncestors,
                    )
                  : Effect.void,
              ),
              { concurrency: "unbounded" },
            );

            if (isDeleteNode(node)) {
              yield* report("deleting");
              if (node.resource.RemovalPolicy === "retain") {
                yield* state.delete({
                  stack: stackName,
                  stage,
                  fqn,
                });
                yield* report("deleted");
                return;
              }
              yield* commit<DeletingResourceState>({
                status: "deleting",
                fqn,
                logicalId,
                instanceId,
                resourceType,
                props,
                attr,
                downstream,
                providerVersion: provider.version ?? 0,
                bindings: excludeDeletedBindings(node.bindings),
                removalPolicy: node.resource.RemovalPolicy,
              });
            }

            if (attr !== undefined) {
              yield* provider
                .delete({
                  id: logicalId,
                  instanceId,
                  olds: props as never,
                  output: attr,
                  session: scopedSession,
                  bindings: [],
                })
                .pipe(
                  instrumentLifecycle(
                    "delete",
                    fqn,
                    resourceType,
                    logicalId,
                    instanceId,
                  ),
                );
            }

            if (isDeleteNode(node)) {
              yield* state.delete({
                stack: stackName,
                stage,
                fqn,
              });
              yield* report("deleted");
            } else {
              yield* scopedSession.note("Cleaning up replaced resource...");
              if (
                node.old.status === "replacing" ||
                node.old.status === "replaced"
              ) {
                // We only deleted the outermost old generation. A nested replacement
                // chain still exists, so stay in `replaced` and pop the chain forward
                // one level. The outer loop will pick this resource up again.
                yield* commit<ReplacedResourceState>({
                  status: "replaced",
                  fqn,
                  logicalId: node.logicalId,
                  instanceId: node.instanceId,
                  resourceType: node.resourceType,
                  props: node.props,
                  attr: node.attr,
                  providerVersion: node.providerVersion,
                  downstream: node.downstream,
                  bindings: excludeDeletedBindings(node.bindings),
                  old: node.old.old,
                  deleteFirst: node.deleteFirst,
                  removalPolicy: node.removalPolicy,
                });
              } else {
                // The old chain is fully drained, so the current replacement is now
                // the stable resource and we can collapse back to a terminal state.
                yield* commit<CreatedResourceState>({
                  status: "created",
                  fqn,
                  logicalId: node.logicalId,
                  instanceId: node.instanceId,
                  resourceType: node.resourceType,
                  props: node.props,
                  attr: node.attr,
                  providerVersion: node.providerVersion,
                  downstream: node.downstream,
                  bindings: excludeDeletedBindings(node.bindings),
                  removalPolicy: node.removalPolicy,
                });
              }
              yield* scopedSession.note("Replaced resource cleanup complete.");
            }
          }),
        ));
      });

    yield* Effect.all(
      Object.values(deletionGraph)
        .filter((node) => node !== undefined)
        .map((node) => deleteResource(node)),
      { concurrency: "unbounded" },
    );
  });

  // The first pass handles both planned deletions and any top-level replaced
  // resources already present in state. Later passes only drain replacement
  // chains that were re-committed as `replaced` while deleting older generations.
  let first = true;
  while (true) {
    const remainingReplacedResources = yield* state.getReplacedResources({
      stack: stackName,
      stage,
    });
    if (!first && remainingReplacedResources.length === 0) {
      break;
    }
    yield* deleteGraph({
      // Orphan/resource deletions from the current plan should only run once.
      ...(first ? plan.deletions : {}),
      ...Object.fromEntries(
        remainingReplacedResources.map((replaced) => [
          toFqn(replaced.namespace, replaced.logicalId),
          replaced,
        ]),
      ),
    });
    first = false;
  }
});

const excludeDeletedBindings = (
  bindings: ReadonlyArray<ResourceBinding & { action?: string }>,
): ResourceBinding[] =>
  bindings.flatMap(({ action, sid, data }) =>
    action === "delete" ? [] : [{ sid, data }],
  );
