import * as Cause from "effect/Cause";
import type { ConfigError } from "effect/Config";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import type { Simplify } from "effect/Types";
import type { ActionLike } from "./Action.ts";
import { makeResolveContext } from "./ActionRuntimeContext.ts";
import { stripUnowned, Unowned } from "./AdoptPolicy.ts";
import { AlchemyContext } from "./AlchemyContext.ts";
import type { AuthError } from "./Auth/AuthProvider.ts";
import {
  type CredentialsRequired,
  demandPlanCredentials,
} from "./Auth/Demand.ts";
import { RuntimeContext } from "./RuntimeContext.ts";
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
import { havePropsChanged, stripUnresolved } from "./Diff.ts";
import type { Input } from "./Input.ts";
import { generateInstanceId, InstanceId } from "./InstanceId.ts";
import * as Output from "./Output.ts";
import {
  type ActionApply,
  type Apply,
  type Delete,
  type Plan,
} from "./Plan.ts";
import {
  findProviderByType,
  missingProviderError,
  tryFindProviderByType,
} from "./Provider.ts";
import { stampedMode, type ProviderMode } from "./ProviderMode.ts";
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
  type ReplacementOldResourceState,
  type ReplacingResourceState,
  type ResourceState,
  type RunningActionState,
  type UpdatedResourceState,
  type UpdatingReourceState,
  State,
  StateStoreError,
} from "./State/index.ts";
import { type ResourceOp, recordResourceOp } from "./Telemetry/Metrics.ts";
import { hashInput } from "./Util/sha256.ts";

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
  | Output.InvalidReferenceError
  | Output.MissingSourceError
  | StateStoreError
  | DestroyError
  | CredentialsRequired
  | AuthError
  | PlatformError
  | ConfigError,
  Cli | State | Stack | Stage
> =>
  Effect.gen(function* () {
    // Credential-free dev: a dev-mode plan that needs the real cloud
    // (`Alchemy.remote()` rows, remote-proxied bindings, deletions of rows
    // stamped `providerMode: "live"`) demands cloud credentials exactly
    // once, up front, BEFORE any lifecycle operation runs — a fully-local
    // dev plan demands nothing. Non-dev runs never enter the seam: live
    // providers keep the pre-existing lazy credential flow. Wired here (not
    // in Deploy/Destroy) because `apply` is the single choke point every
    // path shares — CLI deploy/destroy, `Test.make` deploys, and
    // `test.provider` scratch stacks. See `Auth/Demand.ts`.
    const alchemy = yield* Effect.serviceOption(AlchemyContext);
    if (Option.isSome(alchemy) && alchemy.value.dev) {
      yield* demandPlanCredentials(plan);
    }

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
        providerMode?: ProviderMode;
      }
    >();

    // ── FQN migrations (renamedFrom) ──
    // Persist renames before any lifecycle operation runs: a node whose row
    // was found under a former FQN carries that row pre-remapped in
    // `node.state` (see Plan's rename resolution). Commit it at the current
    // FQN FIRST, then drop the former row — in that order, so an
    // interruption leaves rows at both FQNs with the same instanceId, which
    // the next plan recognizes as an in-flight migration (and never as an
    // orphan to delete).
    //
    // In a same-deploy shift (A→B while B→C), C's former FQN `B` is
    // simultaneously B's migration TARGET. C must NOT delete it: B's own
    // `state.set` supersedes the stale copy, and the migrations run
    // concurrently — the delete could land after B's write and destroy the
    // freshly migrated row.
    const migrationTargets = new Set(
      Object.values(plan.resources)
        .filter((node) => node.renamedFrom?.length && node.state !== undefined)
        .map((node) => node.resource.FQN),
    );
    yield* Effect.forEach(
      Object.values(plan.resources),
      (node) => {
        const { renamedFrom, state: row } = node;
        return renamedFrom === undefined ||
          renamedFrom.length === 0 ||
          row === undefined
          ? Effect.void
          : Effect.gen(function* () {
              yield* state.set({
                stack: stackName,
                stage,
                fqn: node.resource.FQN,
                value: row,
              });
              yield* Effect.forEach(
                renamedFrom.filter(
                  (formerFqn) => !migrationTargets.has(formerFqn),
                ),
                (formerFqn) =>
                  state.delete({ stack: stackName, stage, fqn: formerFqn }),
                { concurrency: "unbounded" },
              );
            });
      },
      { concurrency: "unbounded" },
    );

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
      ({ id, type, status, providerMode }) =>
        session.emit({ kind: "status-change", id, type, status, providerMode }),
      { concurrency: "unbounded" },
    );

    yield* session.done();

    if (plan.destroy) {
      // The destroy converged: every resource row was deleted above. Drop
      // the rest of the stage's persisted state — notably the stack output
      // record written by the last deploy — so `getOutput` returns
      // undefined and `listStages` no longer reports the stage.
      // https://github.com/alchemy-run/alchemy/issues/961
      yield* state.deleteStack({ stack: stackName, stage });
      // Invariant: a successful destroy leaves the stage EMPTY. If rows
      // survive, this destroy session could not actually see (or delete)
      // the stack's state — e.g. its plan listed an empty store while
      // committed rows existed — and reporting success here would silently
      // leak every cloud resource those rows track. Fail loudly instead so
      // the leak surfaces in the run that caused it.
      const remaining = yield* state.list({ stack: stackName, stage });
      if (remaining.length > 0) {
        return yield* Effect.fail(
          new StateStoreError({
            message:
              `destroy of ${stackName}/${stage} reported success but ${remaining.length} ` +
              `state row(s) remain (${remaining.join(", ")}) — the destroy session could ` +
              `not see the stack's persisted state, so its cloud resources were NOT deleted`,
          }),
        );
      }
      return undefined;
    }

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

const executePlan = Effect.fn(function* (
  plan: Plan,
  tracker: Record<string, ResourceTracker>,
  terminalStatuses: Map<
    string,
    {
      id: string;
      type: string;
      status: Extract<ApplyStatus, "created" | "updated" | "ran" | "skipped">;
      providerMode?: ProviderMode;
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
    return yield* Effect.failCause(
      failures.map((f) => f.cause).reduce(Cause.combine),
    );
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
      providerMode?: ProviderMode;
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
        // Early commits (`creating`/`replacing`) persist plan props that may
        // still hold unresolved Output exprs; strip them so state stores only
        // plain data (see stripUnresolved in Diff.ts).
        //
        // Binding rows follow the same rule. Even the RESOLVED binding
        // payload can carry Effect leaves — a tagged Worker/Function class in
        // `env` (the circular-bindings pattern) is a function-typed Effect
        // that `Output.evaluate` passes through untouched. A JSON state store
        // would persist it via its `toJSON` as an `{"_id":"Effect",...}`
        // relic, which the next plan's `diffBindings` compares against the
        // live class stripped to `undefined` — a phantom binding "update" on
        // every deploy, forever. Stripping at the commit boundary keeps both
        // store kinds consistent with the comparison in `havePropsChanged`.
        value: {
          ...value,
          props: stripUnresolved(value.props),
          bindings: stripUnresolved(value.bindings),
          namespace,
        } as S,
      });

    const scopedSession = {
      ...session,
      note: (note: string) =>
        session.emit({ id: logicalId, kind: "annotate", message: note }),
    } satisfies ScopedPlanStatusSession;

    // On a mode-switch replacement (local ⇄ live) surface the transition:
    // the old generation's stamped mode → the mode resolved for this run.
    const fromProviderMode =
      node.action === "replace" &&
      node.mode !== undefined &&
      node.state.providerMode !== undefined &&
      node.state.providerMode !== node.mode
        ? node.state.providerMode
        : undefined;

    const report = (status: ApplyStatus) =>
      session.emit({
        kind: "status-change",
        id: logicalId,
        type: node.resource.Type,
        status,
        providerMode: node.mode,
        fromProviderMode,
      });

    const markTerminal = (status: "created" | "updated") =>
      Effect.gen(function* () {
        terminalStatuses.set(fqn, {
          id: logicalId,
          type: node.resource.Type,
          status,
          providerMode: node.mode,
        });
        // A local dev instance announces where it's serving: any
        // local-mode row whose fresh Attributes carry a string `url`
        // (Workers expose their dev-proxy URL this way) gets a
        // `[id] ready at http://localhost:1337` line.
        if (node.mode === "local") {
          const url = (tracker[fqn]?.output as { url?: unknown })?.url;
          if (typeof url === "string" && url.length > 0) {
            yield* scopedSession.note(`ready at ${url}`);
          }
        }
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
          providerMode: node.mode,
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
      // No work to do on the cloud resource — the persisted attr is already
      // stable. Two pieces of row METADATA can still have drifted from the
      // declaration, and this is the only pass that will ever see them:
      //
      // 1. `resourceType` — the row was persisted under a legacy type name
      //    (the type was since renamed and carries the old name as an
      //    alias); migrate it so the state stops depending on the alias.
      // 2. `removalPolicy` — `RemovalPolicy.retain()` / `.destroy()` is a
      //    decoration on the declaration, not a prop, so changing it never
      //    produces a diff. Without this commit the new policy would never
      //    reach state, and the orphan delete (which reads the policy from
      //    the persisted row, see `Plan.ts`'s delete node) would act on the
      //    stale one — destroying a resource the user had marked `retain`.
      //    See https://github.com/alchemy-run/alchemy/issues/1248.
      const policyChanged =
        node.state.removalPolicy !== node.resource.RemovalPolicy;
      if (node.state.resourceType !== node.resource.Type || policyChanged) {
        yield* commit({
          ...node.state,
          resourceType: node.resource.Type,
          removalPolicy: node.resource.RemovalPolicy,
        });
      }
      // A policy flip is otherwise invisible (the row is a noop), and it is
      // exactly the change a user wants confirmation of. Legacy rows with no
      // persisted policy normalize silently — there is nothing to report.
      if (policyChanged && node.state.removalPolicy !== undefined) {
        yield* scopedSession.note(
          `removal policy ${node.state.removalPolicy} → ${node.resource.RemovalPolicy}`,
        );
      }
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
          providerMode: node.mode,
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
          providerMode: node.mode,
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
            providerMode: node.mode,
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
              fqn,
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
            providerMode: node.mode,
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
            fqn,
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
          // Terminal commits persist the RESOLVED binding payload the
          // provider actually reconciled with, not the raw plan-time
          // expressions. Raw `node.bindings` may hold unresolved Outputs
          // (silently dropped by JSON state stores), so persisting them
          // makes the next plan's `diffBindings` compare a lossy stored
          // shape against fully-resolved data — a phantom binding update
          // on every plan (#874).
          bindings: bindingOutputs,
          providerVersion: node.provider.version ?? 0,
          downstream: node.downstream,
          removalPolicy: node.resource.RemovalPolicy,
          providerMode: node.mode,
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
        const adopting =
          node.adopting === true ||
          (node.state.status === "updating" && node.state.adopting === true);

        yield* node.state.status === "replaced"
          ? commit<ReplacedResourceState>({
              // Keep the replacement wrapper intact while changing the live
              // replacement props; GC still has older generations to delete.
              ...node.state,
              attr: node.state.attr,
              props: news,
              providerMode: node.mode,
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
              adopting: adopting ? true : undefined,
              removalPolicy: node.resource.RemovalPolicy,
              providerMode: node.mode,
            });

        yield* report("updating");

        const previousProps = adopting
          ? undefined
          : node.state.status === "created" ||
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
            fqn,
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
            // Resolved payload, not raw `node.bindings` — see create commit.
            bindings: bindingOutputs,
            providerMode: node.mode,
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
            // Resolved payload, not raw `node.bindings` — see create commit.
            bindings: bindingOutputs,
            providerVersion: node.provider.version ?? 0,
            downstream: node.downstream,
            removalPolicy: node.resource.RemovalPolicy,
            providerMode: node.mode,
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
            providerMode: node.mode,
          });
        } else {
          // Resume the same replacement generation after an interrupted apply.
          replState = node.state;
        }

        // ── delete-first replacements ──
        //
        // By default a replacement is create-first: the new generation is
        // created here and the old generation(s) are reclaimed afterwards by
        // `collectGarbage` (Phase 2). That ordering keeps the old resource
        // alive if the create fails, but it is wrong for resources whose
        // replacement cannot coexist with the original — a fixed physical
        // name, a singleton, etc. Those providers return
        // `{ action: "replace", deleteFirst: true }`.
        //
        // When `deleteFirst` is set we tear the previous generation(s) down
        // BEFORE creating the new one, and commit the result as a terminal
        // `created` state (rather than `replaced`) so Phase 2 has no old chain
        // left to drain. `delete` is required to be idempotent, so a re-run
        // after an interrupted apply simply re-converges.
        const deleteOldGenerations = (
          old: ReplacementOldResourceState,
        ): Effect.Effect<void, any, any> =>
          Effect.gen(function* () {
            const retain = node.resource.RemovalPolicy === "retain";
            if (old.attr !== undefined && !retain) {
              // Delete each old generation with the provider variant of the
              // mode that created it — after a local ⇄ live switch,
              // `node.provider` (the new mode) cannot tear down the other
              // runtime's instance. Unstamped rows (legacy or written by a
              // mode-agnostic provider) are physically live, unless their
              // attrs carry the `dev:` identity marker — see stampedMode.
              const oldProvider = yield* findProviderByType(
                node.resource.Type,
                stampedMode(old),
              );
              yield* oldProvider
                .delete({
                  id: logicalId,
                  fqn,
                  instanceId: old.instanceId,
                  olds: old.props as never,
                  output: old.attr,
                  session: scopedSession,
                  bindings: [],
                })
                .pipe(
                  instrumentLifecycle(
                    "delete",
                    fqn,
                    node.resource.Type,
                    logicalId,
                    old.instanceId,
                  ),
                );
            }
            if (old.status === "replacing" || old.status === "replaced") {
              yield* deleteOldGenerations(old.old);
            }
          });

        if (node.deleteFirst) {
          yield* scopedSession.note(
            "Deleting previous resource before creating its replacement (deleteFirst)...",
          );
          yield* deleteOldGenerations(replState.old);
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
              fqn,
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
            providerMode: node.mode,
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
            fqn,
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

        if (node.deleteFirst) {
          // The old generation(s) were already torn down above, so there is
          // nothing left for `collectGarbage` to drain — collapse straight to
          // the terminal `created` state.
          yield* commit<CreatedResourceState>({
            status: "created",
            fqn,
            logicalId,
            instanceId,
            resourceType: node.resource.Type,
            props: news,
            attr,
            providerVersion: node.provider.version ?? 0,
            // Resolved payload, not raw `node.bindings` — see create commit.
            bindings: bindingOutputs,
            downstream: node.downstream,
            removalPolicy: node.resource.RemovalPolicy,
            providerMode: node.mode,
          });
        } else {
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
            // Resolved payload, not raw `node.bindings` — see create commit.
            bindings: bindingOutputs,
            downstream: node.downstream,
            // Preserve the remaining backlog exactly as-is. GC is responsible for
            // popping one generation at a time until the chain is exhausted.
            old: replState.old,
            deleteFirst: node.deleteFirst,
            removalPolicy: node.resource.RemovalPolicy,
            providerMode: node.mode,
          });
        }

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
          providerMode: node.mode,
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

/**
 * Run an Action body, resolving any Outputs it captured via `yield* output`
 * during init against the current tracker and exposing them to the body through
 * the resolve {@link RuntimeContext}. See {@link makeCaptureContext}.
 */
const runAction = Effect.fn("apply.runAction")(function* (
  task: ActionLike,
  input: any,
  outputs: Record<string, any>,
) {
  const resolved: Record<string, unknown> = {};
  for (const [key, output] of Object.entries(task.Captures)) {
    resolved[key] = yield* Output.evaluate(output, outputs);
  }
  return yield* task
    .Run(input)
    .pipe(Effect.provideService(RuntimeContext, makeResolveContext(resolved)));
});

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
      providerMode?: ProviderMode;
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
      [
        ...new Set([
          ...Object.keys(Output.resolveUpstream(node.input)),
          ...Object.keys(Output.upstreamAny(task.Captures)),
        ]),
      ].filter((f) => f in readyStable),
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

    const result = yield* runAction(task, resolvedInput, outputs);

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

const converge = Effect.fn(function* (
  plan: Plan,
  tracker: Record<string, ResourceTracker>,
  terminalStatuses: Map<
    string,
    {
      id: string;
      type: string;
      status: Extract<ApplyStatus, "created" | "updated" | "ran" | "skipped">;
      providerMode?: ProviderMode;
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
          fqn,
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
          // This site bypasses the `commit` helper, so strip unresolved
          // leaves (Effect-valued env entries survive `Output.evaluate`)
          // the same way `commit` does — state only ever holds plain data.
          props: stripUnresolved(newProps),
          attr,
          providerVersion: node.provider.version ?? 0,
          // Resolved payload, not raw `node.bindings` — see the create
          // commit in applyResource. Stripped like the commit helper so
          // Effect leaves (e.g. tagged Worker classes in `env`) never reach
          // the state store.
          bindings: stripUnresolved(newBindings),
          downstream: node.downstream,
          namespace,
          removalPolicy: node.resource.RemovalPolicy,
          providerMode: node.mode,
        } as UpdatedResourceState,
      });

      terminalStatuses.set(fqn, {
        id: logicalId,
        type: node.resource.Type,
        status: "updated",
        providerMode: node.mode,
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

      const result = yield* runAction(node.def, newInput, outputs);

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

/** A provider delete (or its attr-recovery read / state commit) that failed. */
export interface DeleteFailure {
  fqn: string;
  logicalId: string;
  resourceType: string;
  cause: Cause.Cause<unknown>;
}

/**
 * A delete that was never attempted because a dependent's delete failed (or
 * was itself blocked). The resource may legitimately be undeletable while its
 * dependents still exist, so skipping is not an error in its own right.
 */
export interface BlockedDelete {
  fqn: string;
  logicalId: string;
  resourceType: string;
  /** FQNs of the dependents whose failed/blocked deletes block this one. */
  blockedBy: string[];
}

/**
 * Aggregate raised at the end of the deletion phase when one or more
 * resource deletes failed. Every resource whose delete did not depend on a
 * failed one was still attempted — a single failure no longer strands
 * unrelated siblings.
 */
export class DestroyError extends Data.TaggedError("DestroyError")<{
  failures: ReadonlyArray<DeleteFailure>;
  blocked: ReadonlyArray<BlockedDelete>;
}> {
  override get message(): string {
    return [
      `Failed to delete ${this.failures.length} resource(s)` +
        (this.blocked.length > 0
          ? ` (${this.blocked.length} more skipped because a dependent's delete failed)`
          : "") +
        ":",
      ...this.failures.map(
        (f) => `  ✗ ${f.fqn} (${f.resourceType}): ${Cause.pretty(f.cause)}`,
      ),
      ...this.blocked.map(
        (b) =>
          `  ⊘ ${b.fqn} (${b.resourceType}): skipped — blocked by failed delete of ${b.blockedBy.join(", ")}`,
      ),
    ].join("\n");
  }
}

const collectGarbage = Effect.fn(function* (
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

  // Failures are collected — not propagated — so one bad delete never
  // strands unrelated siblings. `unresolved` tracks every FQN whose delete
  // failed or was blocked this run: later passes must not retry them (a
  // still-`replaced` row would otherwise spin the drain loop forever) and
  // dependencies scheduled in later passes must observe them as blocking.
  const failures: DeleteFailure[] = [];
  const blockedDeletes: BlockedDelete[] = [];
  const unresolved = new Set<string>();

  type DeleteOutcome = "deleted" | "failed" | "blocked";

  const deleteGraph = Effect.fn(function* (
    deletionGraph: Record<string, Delete | ReplacedResourceState | undefined>,
  ) {
    const deletions: {
      [fqn in string]: Effect.Effect<DeleteOutcome, never, ArtifactStore>;
    } = {};

    const deleteResource = (
      node: Delete | ReplacedResourceState,
      ancestors: ReadonlySet<string> = new Set(),
    ): Effect.Effect<DeleteOutcome, never, ArtifactStore> =>
      Effect.gen(function* () {
        const isDeleteNode = (
          node: Delete | ReplacedResourceState,
        ): node is Delete => "action" in node;

        const {
          fqn,
          logicalId,
          namespace,
          resourceType,
          instanceId,
          downstream,
          props,
          attr: persistedAttr,
          provider,
          providerMode,
        } = isDeleteNode(node)
          ? {
              // Use the persisted FQN verbatim — never recompute it from
              // `toFqn(namespace, logicalId)`. A logical ID may legitimately
              // contain the FQN separator (`/`), in which case `parseFqn`
              // truncated it and a recomputed key would miss the real state
              // row (the row would then resurface as an orphan on every
              // subsequent destroy, never getting deleted).
              fqn: node.resource.FQN,
              logicalId: node.resource.LogicalId,
              namespace: node.resource.Namespace,
              resourceType: node.resource.Type,
              instanceId: node.state.instanceId,
              downstream: node.downstream,
              props: node.state.props,
              attr: node.state.attr,
              // Plan resolved this provider for the row's persisted (or
              // marker-inferred) `providerMode` (see the deletions builder
              // in Plan.ts).
              provider: node.provider,
              providerMode: node.state.providerMode,
            }
          : {
              fqn: node.fqn,
              logicalId: node.logicalId,
              namespace: node.namespace,
              resourceType: node.old.resourceType,
              instanceId: node.old.instanceId,
              downstream: node.old.downstream,
              props: node.old.props,
              attr: node.old.attr,
              // A missing provider is fatal — plan already dies on zombie
              // rows (see the deletions builder in Plan.ts); this guards
              // the replaced-chain generations that bypass plan. The old
              // generation is torn down with the provider variant of the
              // mode that created it (local ⇄ live replacements);
              // unstamped rows are physically live unless their attrs
              // carry the `dev:` identity marker (see stampedMode).
              provider: yield* tryFindProviderByType(
                node.old.resourceType,
                stampedMode(node.old),
              ).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.die(
                        missingProviderError(node.old.resourceType, node.fqn),
                      ),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
              providerMode: node.old.providerMode,
            };

        // Mutable: an attr-less row (interrupted create) may recover its
        // attributes from `provider.read` below, right before deletion.
        let attr = persistedAttr;

        const nextAncestors = new Set(ancestors).add(fqn);

        const commit = <S extends ResourceState>(value: Omit<S, "namespace">) =>
          state.set({
            stack: stackName,
            stage,
            fqn,
            // Same rule as the lifecycle commit above: state only stores
            // plain data, never unresolved Output exprs or Effect leaves.
            value: {
              ...value,
              props: stripUnresolved(value.props),
              bindings: stripUnresolved(value.bindings),
              namespace,
            } as S,
          });

        const report = (status: ApplyStatus) =>
          session.emit({
            kind: "status-change",
            id: logicalId,
            type: resourceType,
            status,
            providerMode,
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
            // Dependents (`downstream`) are deleted before this resource. A
            // dependent whose delete failed (or was itself blocked) may make
            // this resource legitimately undeletable (dependency violation),
            // so it is skipped with a "blocked by" note instead of surfacing
            // a spurious second error.
            const dependents = yield* Effect.all(
              downstream.map((dep) =>
                dep !== fqn && !ancestors.has(dep)
                  ? dep in deletionGraph
                    ? deleteResource(
                        deletionGraph[dep] as Delete | ReplacedResourceState,
                        nextAncestors,
                      ).pipe(Effect.map((outcome) => ({ dep, outcome })))
                    : // Not in this pass's graph — but it may have failed in
                      // an earlier drain pass of the same destroy.
                      Effect.sync(() => ({
                        dep,
                        outcome: unresolved.has(dep)
                          ? ("failed" as const)
                          : ("deleted" as const),
                      }))
                  : Effect.succeed({ dep, outcome: "deleted" as const }),
              ),
              { concurrency: "unbounded" },
            );

            const blockedBy = dependents
              .filter(({ outcome }) => outcome !== "deleted")
              .map(({ dep }) => dep);

            if (blockedBy.length > 0) {
              unresolved.add(fqn);
              blockedDeletes.push({
                fqn,
                logicalId,
                resourceType,
                blockedBy,
              });
              yield* scopedSession.note(
                `Skipping delete — blocked by failed delete of ${blockedBy.join(", ")}.`,
              );
              yield* report("skipped");
              return "blocked" as const;
            }

            return yield* deleteResourceBody().pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  unresolved.add(fqn);
                  failures.push({ fqn, logicalId, resourceType, cause });
                  yield* report("fail");
                  return "failed" as const;
                }),
              ),
            );
          }),
        ));

        function deleteResourceBody() {
          return Effect.gen(function* () {
            if (isDeleteNode(node)) {
              yield* report("deleting");
              if (node.resource.RemovalPolicy === "retain") {
                yield* state.delete({
                  stack: stackName,
                  stage,
                  fqn,
                });
                yield* report("retained");
                // Retention is intentional — it never blocks dependencies.
                return "deleted" as const;
              }
            }

            // Honor `retain` for the old generation of a replacement, mirroring
            // the orphan-delete path above. Delete-node retain is already
            // handled with an early return; this guards the replaced
            // old-generation physical delete.
            const retainOldGeneration =
              !isDeleteNode(node) && node.removalPolicy === "retain";

            if (retainOldGeneration) {
              yield* scopedSession.note(
                "Retaining replaced resource (removal policy: retain)...",
              );
            }

            // A row can reach deletion with `attr === undefined` when a create
            // was interrupted after the cloud-side call succeeded but before
            // `reconcile` returned Attributes (a `creating` row — or the old
            // generation of a replacement chain in the same predicament).
            // Skipping the provider's delete outright would silently orphan
            // the physical resource, so ask `read` to look it up from the
            // persisted props (providers derive the deterministic physical
            // name from id/props):
            //   - plain attrs    → exists and is ours; proceed to delete
            //   - Unowned(attrs) → exists but is NOT ours (e.g. our create
            //                      actually lost a name race, or died before
            //                      stamping ownership) — never delete a
            //                      foreign resource; drop our state and say so
            //   - undefined      → nothing exists; dropping state is safe
            if (attr === undefined && !retainOldGeneration) {
              if (provider.read) {
                const recovered = yield* provider
                  .read({
                    id: logicalId,
                    fqn,
                    instanceId,
                    olds: props as never,
                    output: undefined,
                  })
                  .pipe(
                    instrumentLifecycle(
                      "read",
                      fqn,
                      resourceType,
                      logicalId,
                      instanceId,
                    ),
                    // The persisted props of an interrupted create can carry
                    // holes where unresolved Outputs were stripped at commit
                    // time (see stripUnresolved) — e.g. a parent reference
                    // persisted as `{}`. A provider that dereferences one
                    // crashes deep inside its SDK client (a SchemaError
                    // defect), which would make the stage impossible to
                    // destroy. Recovery is best-effort: degrade the defect
                    // to "nothing recovered", surface a note, and let the
                    // row be dropped (#995).
                    Effect.catchDefect((defect) =>
                      scopedSession
                        .note(
                          "Recovery read crashed while looking up this " +
                            "resource's interrupted create " +
                            `(${String(defect)}) — if a physical resource ` +
                            "was created, it must be cleaned up manually.",
                        )
                        .pipe(Effect.as(undefined)),
                    ),
                  );
                if (recovered !== undefined) {
                  if (Unowned.is(recovered)) {
                    yield* scopedSession.note(
                      "Resource exists in the cloud but is not owned by this " +
                        "stack — leaving it in place (re-deploy with --adopt " +
                        "to take ownership, then destroy).",
                    );
                  } else {
                    attr = stripUnowned(recovered as Record<string, any>);
                  }
                }
              } else {
                yield* scopedSession.note(
                  "No attributes were recorded for this resource (its create " +
                    "was interrupted) and the provider does not implement " +
                    "`read` — if a physical resource was created, it must be " +
                    "cleaned up manually.",
                );
              }
            }

            if (isDeleteNode(node)) {
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
                providerMode,
              });
            }

            if (attr !== undefined && !retainOldGeneration) {
              yield* provider
                .delete({
                  id: logicalId,
                  fqn,
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
              if (!retainOldGeneration) {
                yield* scopedSession.note("Cleaning up replaced resource...");
              }
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
                  providerMode: node.providerMode,
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
                  providerMode: node.providerMode,
                });
              }
              yield* scopedSession.note(
                retainOldGeneration
                  ? "Replaced resource retained."
                  : "Replaced resource cleanup complete.",
              );
            }
            return "deleted" as const;
          });
        }
      });

    // Attempt every root. Per-node failures were recorded (and their state
    // retained) inside each node's delete effect — the effects resolve to
    // outcomes and never fail, so one bad resource never interrupts sibling
    // deletions mid-flight.
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
    const remainingReplacedResources = (yield* state.getReplacedResources({
      stack: stackName,
      stage,
    }))
      // A row whose drain already failed (or was blocked) this run stays
      // `replaced` in state — retrying it in a later pass would loop forever.
      // It stays behind for the next destroy; the aggregate error below
      // reports it.
      .filter((replaced) => !unresolved.has(replaced.fqn));
    if (!first && remainingReplacedResources.length === 0) {
      break;
    }
    yield* deleteGraph({
      // Orphan/resource deletions from the current plan should only run once.
      ...(first ? plan.deletions : {}),
      ...Object.fromEntries(
        remainingReplacedResources.map((replaced) => [
          // Key by the persisted FQN (not a recomputed one) so logical IDs
          // containing the FQN separator round-trip correctly.
          replaced.fqn,
          replaced,
        ]),
      ),
    });
    first = false;
  }

  if (failures.length > 0) {
    // Every independent delete was still attempted; now surface everything
    // that went wrong (and everything skipped as a consequence) as one
    // typed aggregate. The destroy as a whole still fails.
    return yield* Effect.fail(
      new DestroyError({ failures, blocked: blockedDeletes }),
    );
  }
});

const excludeDeletedBindings = (
  bindings: ReadonlyArray<ResourceBinding & { action?: string }>,
): ResourceBinding[] =>
  bindings.flatMap(({ action, sid, data }) =>
    action === "delete" ? [] : [{ sid, data }],
  );
