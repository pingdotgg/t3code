/** @effect-diagnostics anyUnknownInErrorContext:off */
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { stripUnowned } from "./AdoptPolicy.ts";
import {
  Artifacts,
  ArtifactStore,
  createArtifactStore,
  ensureArtifactStore,
  makeScopedArtifacts,
} from "./Artifacts.ts";
import { deepEqual } from "./Diff.ts";
import { captureEmit, emit } from "./Events.ts";
import type { Apply, Plan } from "./Plan.ts";
import { findProviderByType, Provider } from "./Provider.ts";
import { stampedMode } from "./ProviderMode.ts";
import { resourceSession } from "./Report.ts";
import type { ResourceLike } from "./Resource.ts";
import { ResourceContext } from "./ResourceContext.ts";
import {
  isActionState,
  State,
  type CreatedResourceState,
  type ResourceState,
  type UpdatedResourceState,
} from "./State/index.ts";
import { type ResourceOp, recordResourceOp } from "./Telemetry/Metrics.ts";
import { findCycleMembers } from "./Util/scc.ts";

/**
 * The outcome of checking or repairing drift for a single resource.
 *
 * - `unchanged` — the observed cloud state matches the persisted attributes.
 * - `drifted`   — (dry-run only) the cloud state diverged from the persisted
 *                 attributes; a non-dry-run drift would repair it.
 * - `missing`   — (dry-run only) the resource no longer exists in the cloud;
 *                 a non-dry-run drift would recreate it.
 * - `repaired`  — drift was detected and the resource was reconciled back to
 *                 its desired (last-deployed) state.
 * - `recreated` — the resource was missing from the cloud and was reconciled
 *                 from scratch, reusing the persisted instance id so
 *                 deterministic physical names converge to the same values.
 * - `skipped`   — the resource was not checked; see `reason` (provider has no
 *                 `read`, or the persisted status is not stable).
 */
export type DriftAction =
  | "unchanged"
  | "drifted"
  | "missing"
  | "repaired"
  | "recreated"
  | "skipped";

export interface DriftResourceResult {
  fqn: string;
  logicalId: string;
  resourceType: string;
  action: DriftAction;
  /** Why the resource was skipped (only set when `action === "skipped"`). */
  reason?: string;
  /**
   * The resource's attributes after the drift: the reconciled attributes for
   * `repaired`/`recreated`, the observed cloud attributes for `drifted`, and
   * the persisted attributes for `unchanged`. Unset for `missing`/`skipped`.
   */
  attr?: any;
}

export interface DriftResult {
  resources: Record<string, DriftResourceResult>;
}

/** A provider lifecycle failure annotated with the resource being checked. */
export class DriftResourceError extends Data.TaggedError("DriftResourceError")<{
  readonly message: string;
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
  readonly operation: ResourceOp;
  readonly cause: unknown;
}> {}

/**
 * Reconcile state drift for every resource persisted under `stack`/`stage`.
 *
 * Unlike `deploy` (which converges the cloud to a *new* desired state
 * computed from the stack program), `drift` converges the cloud back to the
 * *last-deployed* desired state recorded in the state store. It needs no
 * stack program — only the state store and the resource providers.
 *
 * The algorithm, per resource, is observe → compare → converge:
 *
 * 1. **Read** — call `provider.read` with the persisted props/attributes to
 *    observe the live cloud state.
 * 2. **Compare** — deep-compare the observed attributes against the
 *    persisted attributes. Equal ⇒ `unchanged`.
 * 3. **Reconcile** — on drift, call `provider.reconcile` with the persisted
 *    props as the desired state (`news`) and the *observed* attributes as
 *    `output`, so the provider diffs against reality rather than a stale
 *    snapshot. When the resource is missing entirely, reconcile runs
 *    greenfield (`olds`/`output` undefined) under the *same* instance id so
 *    deterministic physical names regenerate identically.
 * 4. **Persist** — write the fresh attributes back to the state store.
 *
 * Resources are observed concurrently. Repairs follow the persisted
 * `downstream` edges: a recreated topic exists before its subscription is
 * recreated. Missing resources are recreated without their bindings first and
 * bound once every missing resource exists again, because binding data (an S3
 * notification's target topic) can point at a resource recreated later. A
 * failure checking one resource does not interrupt the others; all failures
 * are aggregated into a single combined cause after every resource has been
 * attempted.
 *
 * Resources that cannot be checked are reported as `skipped` rather than
 * failing the run: providers without `read` (nothing to observe), and
 * resources whose persisted status is not stable (`creating`, `updating`,
 * `replacing`, `replaced`, `deleting`) — those represent an interrupted
 * deploy and must be recovered by `deploy`, which owns replacement chains
 * and dependency ordering. Action rows have no cloud state and are ignored.
 */
const runDrift = (
  stack: { name: string; stage: string },
  options: {
    readonly dryRun: boolean;
    /** Check and repair only these resources; the rest of the stage is untouched. */
    readonly only?: ReadonlyArray<string>;
  },
): Effect.Effect<DriftResult, any, State> =>
  Effect.gen(function* () {
    // Phase markers and per-resource progress are emitted as events so
    // renderers can show the drift check as it runs.
    yield* emit({ type: "plan.phase", phase: "loading-state" });
    const state = yield* yield* State;
    const reportEvent = yield* captureEmit;
    const stackName = stack.name;
    const stage = stack.stage;
    const dryRun = options.dryRun;

    const driftResource = Effect.fn("drift.resource")(function* (fqn: string) {
      const persisted = yield* state.get({ stack: stackName, stage, fqn });
      // Action rows have no cloud state to drift.
      if (!persisted || isActionState(persisted)) {
        return undefined;
      }
      const old = persisted as ResourceState;
      const { logicalId, instanceId, resourceType, namespace } = old;

      const result = (
        partial: Pick<DriftResourceResult, "action" | "reason" | "attr">,
      ): DriftResourceResult => ({
        fqn,
        logicalId,
        resourceType,
        ...partial,
      });

      const scopedSession = resourceSession(reportEvent, fqn, logicalId);

      const report = (status: "updating" | "updated" | "creating" | "created" | "skipped") =>
        reportEvent({
          type: "apply.resource.status",
          fqn,
          id: logicalId,
          resourceType,
          status,
        });

      // Surface the skip reason through the session (the TUI renders it as a
      // note under the row; the logging CLI prints it) and settle the row
      // with a terminal `skipped` status so it never shows as in-progress.
      const skip = (reason: string) =>
        Effect.gen(function* () {
          yield* scopedSession.note(reason);
          yield* report("skipped");
          return result({ action: "skipped", reason });
        });

      if (old.status !== "created" && old.status !== "updated") {
        // Anything mid-flight (or with a pending replacement chain) belongs
        // to `deploy`'s recovery machinery — replacement generations and
        // dependency ordering are not drift's to drive.
        return yield* skip(
          old.status === "replaced" || old.status === "replacing"
            ? `resource has a pending replacement (status '${old.status}'); run deploy to finish it`
            : `resource status '${old.status}' is not stable; run deploy to recover`,
        );
      }

      // Observe with the provider variant of the mode that created the row —
      // a local dev worker's state must be read by the local provider.
      // Legacy unstamped rows infer "local" from a `dev:` identity marker.
      const provider = yield* findProviderByType(resourceType, stampedMode(old));
      if (!provider.read) {
        return yield* skip(`provider '${resourceType}' does not implement read`);
      }

      // Persist a repaired row. Everything but the status, attributes and
      // bindings carries over from the persisted row — notably the
      // `providerMode` stamp, without which a repaired local row would be
      // treated as live.
      const commit = (
        status: "created" | "updated",
        attr: ResourceState["attr"],
        bindings: ResourceState["bindings"],
      ) => {
        const row = {
          kind: old.kind,
          namespace,
          fqn,
          logicalId,
          instanceId,
          resourceType,
          props: old.props!,
          attr: attr!,
          providerVersion: provider.version ?? 0,
          bindings,
          downstream: old.downstream,
          removalPolicy: old.removalPolicy,
          providerMode: old.providerMode,
          adoptionBlocked: old.adoptionBlocked,
        };
        return state.set({
          stack: stackName,
          stage,
          fqn,
          value:
            status === "created"
              ? ({ ...row, status } satisfies CreatedResourceState)
              : ({ ...row, status } satisfies UpdatedResourceState),
        });
      };

      // Paired with the resource-planned completion so renderers can show
      // which rows' cloud reads are actually in flight (the slowest part of
      // a drift check). Emitted after the skip gates: skipped rows settle
      // instantly and never read the cloud.
      yield* emit({
        type: "plan.resource.started",
        fqn,
        logicalId,
        resourceType,
        total: fqns.length,
      });
      const observed = yield* provider
        .read({
          id: logicalId,
          fqn,
          instanceId,
          olds: old.props as never,
          output: old.attr as never,
        })
        .pipe(instrumentLifecycle("read", fqn, resourceType, logicalId, instanceId));

      if (observed === undefined) {
        if (dryRun) {
          return result({ action: "missing" });
        }
        return { fqn, old, provider, live: undefined, result, scopedSession, report, commit };
      }

      // `read` may brand the attributes as Unowned when ownership markers
      // (tags) have drifted out from under us — the brand is a plan-time
      // routing hint, never persisted, and here the state store already
      // records the resource as ours. Tag drift then surfaces through the
      // attribute comparison below and repairs like any other drift.
      const live = stripUnowned(observed);

      if (deepEqual(live, old.attr)) {
        return result({ action: "unchanged", attr: old.attr });
      }

      if (dryRun) {
        return result({ action: "drifted", attr: live });
      }
      return { fqn, old, provider, live, result, scopedSession, report, commit };
    });
    type PendingRepair = Extract<
      Effect.Success<ReturnType<typeof driftResource>>,
      { old: unknown }
    >;
    const isPendingRepair = (
      observed: DriftResourceResult | PendingRepair | undefined,
    ): observed is PendingRepair => observed !== undefined && "old" in observed;

    // ── missing — recreate under the same instance id, without bindings ──
    //
    // Binding data often points at other resources (an S3 notification
    // targets a topic), and a binding edge inside a cycle is not recorded in
    // `downstream`. So, like Apply's precreate, missing resources are first
    // created bare in `downstream` order; their bindings are attached in the
    // second phase, once every missing resource exists again. The bare
    // create is committed with no bindings so a crash in between leaves a
    // row the next deploy re-binds.
    const recreate = Effect.fn("drift.recreate")(function* (pending: PendingRepair) {
      const { fqn, old, provider, report, commit, scopedSession, result } = pending;
      const { logicalId, instanceId, resourceType } = old;
      const bindings = old.bindings ?? [];
      yield* report("creating");
      const attr = yield* provider
        .reconcile({
          id: logicalId,
          fqn,
          instanceId,
          news: old.props as never,
          olds: undefined,
          output: undefined,
          session: scopedSession,
          bindings: [] as never,
        })
        .pipe(instrumentLifecycle("create", fqn, resourceType, logicalId, instanceId));
      yield* commit("created", attr, []);
      if (bindings.length === 0) {
        yield* report("created");
        return { done: result({ action: "recreated", attr }) };
      }
      return { rebind: { ...pending, live: attr, recreated: true } };
    });

    // ── drifted — converge the cloud back to the last-deployed props ──
    //
    // Also attaches the bindings of resources recreated bare above.
    const reconcile = Effect.fn("drift.reconcile")(function* (
      pending: PendingRepair & { recreated: boolean },
    ) {
      const { fqn, old, provider, live, report, commit, scopedSession, result, recreated } =
        pending;
      const { logicalId, instanceId, resourceType } = old;
      if (!recreated) yield* report("updating");
      const attr = yield* provider
        .reconcile({
          id: logicalId,
          fqn,
          instanceId,
          news: old.props as never,
          olds: old.props as never,
          // Hand reconcile the OBSERVED attributes, not the stale persisted
          // snapshot, so its observed-vs-desired diffing works from reality.
          output: live as never,
          session: scopedSession,
          bindings: old.bindings as never,
        })
        .pipe(
          instrumentLifecycle(
            recreated ? "create" : "update",
            fqn,
            resourceType,
            logicalId,
            instanceId,
          ),
        );
      yield* commit(recreated ? "created" : "updated", attr, old.bindings);
      yield* report(recreated ? "created" : "updated");
      return result({ action: recreated ? "recreated" : "repaired", attr });
    });

    const listed = yield* state.list({ stack: stackName, stage });
    const fqns =
      options.only === undefined ? listed : listed.filter((fqn) => options.only!.includes(fqn));
    yield* emit({ type: "plan.phase", phase: "computing-plan" });

    // Per-resource observation progress: each row is reported through the
    // events as its cloud read lands (drift checks are the
    // slowest planning path). Failed or action rows advance the count
    // without an event, so progress stays monotonic.
    const observedCount = yield* Ref.make(0);
    const resourceObserved = (observed: DriftResourceResult | PendingRepair | undefined) =>
      Ref.updateAndGet(observedCount, (count) => count + 1).pipe(
        Effect.flatMap((completed) =>
          observed === undefined
            ? Effect.void
            : emit({
                type: "plan.resource.completed",
                fqn: observed.fqn,
                logicalId: isPendingRepair(observed) ? observed.old.logicalId : observed.logicalId,
                resourceType: isPendingRepair(observed)
                  ? observed.old.resourceType
                  : observed.resourceType,
                // Drift observation compares attributes, not binding rows.
                bindings: [],
                action: isPendingRepair(observed)
                  ? observed.live === undefined
                    ? "create"
                    : "update"
                  : observed.action === "drifted"
                    ? "update"
                    : observed.action === "missing"
                      ? "create"
                      : "noop",
                completed,
                total: fqns.length,
              }),
        ),
      );

    // Drift every resource even if some fail, then surface all failures as
    // one combined cause (mirrors Apply's failure aggregation).
    const failures: Cause.Cause<unknown>[] = [];
    const recordFailure = (fqn: string) => (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        failures.push(cause);
        const persisted = yield* state
          .get({ stack: stackName, stage, fqn })
          .pipe(Effect.orElseSucceed(() => undefined));
        if (persisted && !isActionState(persisted)) {
          yield* reportEvent({
            type: "apply.resource.status",
            fqn,
            id: persisted.logicalId,
            resourceType: persisted.resourceType,
            status: "fail",
          });
        }
        return undefined;
      });

    const observed = yield* Effect.forEach(
      fqns,
      (fqn) =>
        driftResource(fqn).pipe(
          Effect.catchCause(recordFailure(fqn)),
          Effect.tap(resourceObserved),
        ),
      { concurrency: "unbounded" },
    );

    const pending = observed.filter(isPendingRepair);

    // Upstreams per the persisted `downstream` edges, among the resources
    // being repaired (an unchanged or skipped upstream never blocks). Edges
    // inside a cycle — only possible through merged historical edges — are
    // dropped.
    const upstream: Record<string, string[]> = Object.fromEntries(
      pending.map((node) => [node.fqn, [] as string[]]),
    );
    for (const node of pending) {
      for (const down of node.old.downstream ?? []) {
        if (down !== node.fqn) upstream[down]?.push(node.fqn);
      }
    }
    const cyclic = findCycleMembers(upstream);
    const upstreamOf = (fqn: string) =>
      upstream[fqn]!.filter((up) => !(cyclic.has(up) && cyclic.has(fqn)));

    // Resources whose repair failed, or was skipped because an upstream's
    // did. Like Apply, a dependent never runs against a failed upstream.
    const failed = new Set<string>();

    // Run `run` over `nodes`, each node after its upstreams in `nodes` have
    // settled. Upstreams outside `nodes` settled in an earlier phase.
    const inDependencyOrder = Effect.fn(function* <N extends PendingRepair, A>(
      nodes: ReadonlyArray<N>,
      run: (node: N) => Effect.Effect<A, unknown>,
    ) {
      const settled = new Map<string, Deferred.Deferred<void>>();
      for (const node of nodes) settled.set(node.fqn, yield* Deferred.make<void>());
      return yield* Effect.forEach(
        nodes,
        (node) =>
          Effect.gen(function* () {
            const ups = upstreamOf(node.fqn);
            yield* Effect.all(
              ups.flatMap((up) => {
                const deferred = settled.get(up);
                return deferred ? [Deferred.await(deferred)] : [];
              }),
            );
            const blocked = ups.filter((up) => failed.has(up));
            if (blocked.length > 0) {
              failed.add(node.fqn);
              yield* node.scopedSession.note(
                `not repaired: upstream ${blocked.map((up) => `'${up}'`).join(", ")} failed`,
              );
              yield* node.report("skipped");
              return undefined;
            }
            return yield* run(node).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => failed.add(node.fqn)).pipe(
                  Effect.andThen(recordFailure(node.fqn)(cause)),
                ),
              ),
            );
          }).pipe(Effect.ensuring(Deferred.succeed(settled.get(node.fqn)!, undefined))),
        { concurrency: "unbounded" },
      );
    });

    const recreated = yield* inDependencyOrder(
      pending.filter((node) => node.live === undefined),
      recreate,
    );
    const rebind = recreated.flatMap((node) => (node?.rebind ? [node.rebind] : []));
    const repaired = yield* inDependencyOrder(
      [
        ...pending
          .filter((node) => node.live !== undefined)
          .map((node) => ({ ...node, recreated: false })),
        ...rebind,
      ],
      reconcile,
    );

    const results = [
      ...observed.filter((r) => !isPendingRepair(r)),
      ...recreated.map((r) => r?.done),
      ...repaired,
    ].filter((r): r is DriftResourceResult => r !== undefined);

    if (failures.length > 0) {
      return yield* Effect.failCause(failures.reduce(Cause.combine) as Cause.Cause<never>);
    }

    return {
      resources: Object.fromEntries(
        results.filter((r): r is DriftResourceResult => r !== undefined).map((r) => [r.fqn, r]),
      ),
    } satisfies DriftResult;
  }).pipe(
    ensureArtifactStore,
    Effect.withSpan("drift", {
      attributes: {
        "alchemy.stack": stack.name,
        "alchemy.stage": stack.stage,
        "alchemy.dry_run": !!options.dryRun,
      },
    }),
  );

/** Detect drift without reconciling resources or updating state. */
export const detect = (stack: { name: string; stage: string }) => runDrift(stack, { dryRun: true });

/**
 * Reconcile resources back to their last-deployed desired state. With
 * `only`, just those resources are re-checked and repaired.
 */
export const repair = (
  stack: { name: string; stage: string },
  options: { readonly only?: ReadonlyArray<string> } = {},
) => runDrift(stack, { dryRun: false, only: options.only });

/**
 * Same shape as Apply's lifecycle instrumentation: scoped artifacts +
 * resource context, the resource op metrics, and a `provider.<op>` span.
 */
const instrumentLifecycle =
  (op: ResourceOp, fqn: string, resourceType: string, logicalId: string, instanceId: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DriftResourceError, Exclude<R, ResourceContext | Artifacts>> =>
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- generic Exclude on R can't be proven statically
    Effect.serviceOption(ArtifactStore).pipe(
      Effect.map(Option.getOrElse(createArtifactStore)),
      Effect.flatMap((store) =>
        effect.pipe(
          Effect.provide([
            Layer.succeed(Artifacts, makeScopedArtifacts(store, fqn)),
            Layer.succeed(ResourceContext, { logicalId, fqn, instanceId, type: resourceType }),
          ]),
          Effect.catchCauseIf(
            (cause: Cause.Cause<E>) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.fail(
                new DriftResourceError({
                  message: `Resource '${fqn}' (${resourceType}) failed during ${op}`,
                  fqn,
                  logicalId,
                  resourceType,
                  operation: op,
                  cause: Cause.squash(cause),
                }),
              ),
          ),
        ),
      ),
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
    ) as Effect.Effect<A, E | DriftResourceError, Exclude<R, ResourceContext | Artifacts>>;

export interface DriftPlan {
  /** Per-resource detection outcome (a dry-run {@link DriftResult}). */
  result: DriftResult;
  /**
   * The detection outcome projected onto the engine's {@link Plan} shape so
   * the CLI renders a drift exactly like a deploy plan (ink TUI when
   * interactive, plain logging otherwise): `drifted` → `update`, `missing` →
   * `create`, `unchanged`/`skipped` → `noop`.
   */
  plan: Plan;
}

/**
 * Run the drift-detection pass and project the
 * outcome onto a {@link Plan} for display/approval. The plan is a read-only
 * view — {@link repair} re-observes the cloud rather than trusting the
 * detection snapshot.
 */
export const plan = (stack: {
  name: string;
  stage: string;
}): Effect.Effect<DriftPlan, any, State> =>
  Effect.gen(function* () {
    const result = yield* detect(stack);
    const state = yield* yield* State;

    const resources: Plan["resources"] = {};
    for (const [fqn, r] of Object.entries(result.resources)) {
      const persisted = yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn,
      });
      if (!persisted || isActionState(persisted)) continue;
      // Repair the row with the provider mode that created it (drift never
      // switches modes — a local ⇄ live switch is a plan-time replacement).
      const provider = yield* findProviderByType(persisted.resourceType, stampedMode(persisted));
      const action =
        r.action === "drifted"
          ? ("update" as const)
          : r.action === "missing"
            ? ("create" as const)
            : ("noop" as const);
      resources[fqn] = {
        action,
        props: persisted.props,
        drift:
          r.action === "drifted" || r.action === "missing"
            ? {
                expected: persisted.attr,
                actual: r.attr,
                missing: r.action === "missing",
              }
            : undefined,
        state: persisted,
        provider,
        mode: persisted.providerMode,
        // Synthetic ResourceLike reconstructed from persisted state, the
        // same way Plan.make builds its deletion nodes.
        resource: {
          Namespace: persisted.namespace,
          FQN: fqn,
          LogicalId: persisted.logicalId,
          Type: persisted.resourceType,
          Attributes: persisted.attr,
          Props: persisted.props,
          Binding: undefined!,
          Provider: Provider(persisted.resourceType),
          RemovalPolicy: persisted.removalPolicy,
          Adopt: undefined,
          RequiresImplementation: undefined,
          FormerFqns: undefined,
          Mode: persisted.providerMode,
          RuntimeContext: undefined!,
          Providers: undefined,
        } as ResourceLike,
        // Drift repairs from the persisted bindings verbatim — surface them
        // as noop rows so the renderer shows the binding topology without
        // implying binding changes.
        bindings: (persisted.bindings ?? []).map((binding) => ({
          sid: binding.sid,
          action: "noop" as const,
          data: binding.data,
        })),
        downstream: persisted.downstream ?? [],
      } as Apply;
    }

    return {
      result,
      plan: {
        resources,
        actions: {},
        deletions: {},
        actionDeletions: {},
        output: undefined,
        cycleMembers: new Set<string>(),
      },
    } satisfies DriftPlan;
  }).pipe(
    Effect.withSpan("drift.plan", {
      attributes: {
        "alchemy.stack": stack.name,
        "alchemy.stage": stack.stage,
      },
    }),
  );
