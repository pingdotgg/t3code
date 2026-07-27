/** @effect-diagnostics anyUnknownInErrorContext:off */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { stripUnowned } from "./AdoptPolicy.ts";
import {
  Artifacts,
  ArtifactStore,
  createArtifactStore,
  ensureArtifactStore,
  makeScopedArtifacts,
} from "./Artifacts.ts";
import type { PlanStatusSession, ScopedPlanStatusSession } from "./Cli/Cli.ts";
import { deepEqual } from "./Diff.ts";
import { InstanceId } from "./InstanceId.ts";
import type { Apply, Plan } from "./Plan.ts";
import { findProviderByType, Provider } from "./Provider.ts";
import type { ResourceLike } from "./Resource.ts";
import {
  isActionState,
  State,
  type CreatedResourceState,
  type ResourceState,
  type UpdatedResourceState,
} from "./State/index.ts";
import { type ResourceOp, recordResourceOp } from "./Telemetry/Metrics.ts";

/**
 * The outcome of syncing a single resource.
 *
 * - `unchanged` — the observed cloud state matches the persisted attributes.
 * - `drifted`   — (dry-run only) the cloud state diverged from the persisted
 *                 attributes; a non-dry-run sync would repair it.
 * - `missing`   — (dry-run only) the resource no longer exists in the cloud;
 *                 a non-dry-run sync would recreate it.
 * - `repaired`  — drift was detected and the resource was reconciled back to
 *                 its desired (last-deployed) state.
 * - `recreated` — the resource was missing from the cloud and was reconciled
 *                 from scratch, reusing the persisted instance id so
 *                 deterministic physical names converge to the same values.
 * - `skipped`   — the resource was not synced; see `reason` (provider has no
 *                 `read`, or the persisted status is not stable).
 */
export type SyncAction =
  | "unchanged"
  | "drifted"
  | "missing"
  | "repaired"
  | "recreated"
  | "skipped";

export interface SyncResourceResult {
  fqn: string;
  logicalId: string;
  resourceType: string;
  action: SyncAction;
  /** Why the resource was skipped (only set when `action === "skipped"`). */
  reason?: string;
  /**
   * The resource's attributes after the sync: the reconciled attributes for
   * `repaired`/`recreated`, the observed cloud attributes for `drifted`, and
   * the persisted attributes for `unchanged`. Unset for `missing`/`skipped`.
   */
  attr?: any;
}

export interface SyncResult {
  resources: Record<string, SyncResourceResult>;
}

export interface SyncOptions {
  /**
   * Detect and report drift without repairing it. No provider `reconcile`
   * runs and no state is persisted — resources report `drifted`/`missing`
   * instead of `repaired`/`recreated`.
   */
  dryRun?: boolean;
  /** Optional progress session (the CLI passes one; tests usually don't). */
  session?: PlanStatusSession;
}

const noopSession: PlanStatusSession = {
  emit: () => Effect.void,
  done: () => Effect.void,
};

/**
 * Reconcile state drift for every resource persisted under `stack`/`stage`.
 *
 * Unlike `deploy` (which converges the cloud to a *new* desired state
 * computed from the stack program), `sync` converges the cloud back to the
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
 * Resources are synced concurrently and independently — persisted props are
 * fully resolved values, so there are no upstream/downstream data edges to
 * order by. A failure syncing one resource does not interrupt the others;
 * all failures are aggregated into a single combined cause after every
 * resource has been attempted.
 *
 * Resources that cannot be synced are reported as `skipped` rather than
 * failing the run: providers without `read` (nothing to observe), and
 * resources whose persisted status is not stable (`creating`, `updating`,
 * `replacing`, `replaced`, `deleting`) — those represent an interrupted
 * deploy and must be recovered by `deploy`, which owns replacement chains
 * and dependency ordering. Action rows have no cloud state and are ignored.
 */
export const sync = (
  stack: { name: string; stage: string },
  options: SyncOptions = {},
): Effect.Effect<SyncResult, any, State> =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const session = options.session ?? noopSession;
    const stackName = stack.name;
    const stage = stack.stage;
    const dryRun = options.dryRun ?? false;

    const syncResource = Effect.fn("sync.resource")(function* (fqn: string) {
      const persisted = yield* state.get({ stack: stackName, stage, fqn });
      // Action rows have no cloud state to drift.
      if (!persisted || isActionState(persisted)) {
        return undefined;
      }
      const old = persisted as ResourceState;
      const { logicalId, instanceId, resourceType, namespace } = old;

      const result = (
        partial: Pick<SyncResourceResult, "action" | "reason" | "attr">,
      ): SyncResourceResult => ({
        fqn,
        logicalId,
        resourceType,
        ...partial,
      });

      const scopedSession = {
        ...session,
        note: (note: string) =>
          session.emit({ id: logicalId, kind: "annotate", message: note }),
      } satisfies ScopedPlanStatusSession;

      const report = (
        status: "updating" | "updated" | "creating" | "created" | "skipped",
      ) =>
        session.emit({
          kind: "status-change",
          id: logicalId,
          type: resourceType,
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
        // dependency ordering are not sync's to drive.
        return yield* skip(
          old.status === "replaced" || old.status === "replacing"
            ? `resource has a pending replacement (status '${old.status}'); run deploy to finish it`
            : `resource status '${old.status}' is not stable; run deploy to recover`,
        );
      }

      const provider = yield* findProviderByType(resourceType);
      if (!provider.read) {
        return yield* skip(
          `provider '${resourceType}' does not implement read`,
        );
      }

      const commit = (value: Omit<ResourceState, "namespace">) =>
        state.set({
          stack: stackName,
          stage,
          fqn,
          value: { ...value, namespace } as ResourceState,
        });

      const observed = yield* provider
        .read({
          id: logicalId,
          fqn,
          instanceId,
          olds: old.props as never,
          output: old.attr as never,
        })
        .pipe(
          instrumentLifecycle("read", fqn, resourceType, logicalId, instanceId),
        );

      // ── missing — recreate under the same instance id ──
      if (observed === undefined) {
        if (dryRun) {
          return result({ action: "missing" });
        }
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
            bindings: old.bindings as never,
          })
          .pipe(
            instrumentLifecycle(
              "create",
              fqn,
              resourceType,
              logicalId,
              instanceId,
            ),
          );
        yield* commit({
          status: "created",
          fqn,
          logicalId,
          instanceId,
          resourceType,
          props: old.props!,
          attr,
          providerVersion: provider.version ?? 0,
          bindings: old.bindings,
          downstream: old.downstream,
          removalPolicy: old.removalPolicy,
        } satisfies Omit<CreatedResourceState, "namespace">);
        yield* report("created");
        return result({ action: "recreated", attr });
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

      // ── drifted — converge the cloud back to the last-deployed props ──
      yield* report("updating");
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
            "update",
            fqn,
            resourceType,
            logicalId,
            instanceId,
          ),
        );
      yield* commit({
        status: "updated",
        fqn,
        logicalId,
        instanceId,
        resourceType,
        props: old.props!,
        attr,
        providerVersion: provider.version ?? 0,
        bindings: old.bindings,
        downstream: old.downstream,
        removalPolicy: old.removalPolicy,
      } satisfies Omit<UpdatedResourceState, "namespace">);
      yield* report("updated");
      return result({ action: "repaired", attr });
    });

    const fqns = yield* state.list({ stack: stackName, stage });

    // Sync every resource even if some fail, then surface all failures as
    // one combined cause (mirrors Apply's failure aggregation).
    const failures: Cause.Cause<unknown>[] = [];
    const results = yield* Effect.all(
      fqns.map((fqn) =>
        syncResource(fqn).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              failures.push(cause);
              const persisted = yield* state
                .get({ stack: stackName, stage, fqn })
                .pipe(Effect.orElseSucceed(() => undefined));
              if (persisted && !isActionState(persisted)) {
                yield* session.emit({
                  kind: "status-change",
                  id: persisted.logicalId,
                  type: persisted.resourceType,
                  status: "fail",
                });
              }
              return undefined;
            }),
          ),
        ),
      ),
      { concurrency: "unbounded" },
    );

    yield* session.done();

    if (failures.length > 0) {
      return yield* Effect.failCause(
        failures.reduce(Cause.combine) as Cause.Cause<never>,
      );
    }

    return {
      resources: Object.fromEntries(
        results
          .filter((r): r is SyncResourceResult => r !== undefined)
          .map((r) => [r.fqn, r]),
      ),
    } satisfies SyncResult;
  }).pipe(
    ensureArtifactStore,
    Effect.withSpan("sync", {
      attributes: {
        "alchemy.stack": stack.name,
        "alchemy.stage": stack.stage,
        "alchemy.dry_run": !!options.dryRun,
      },
    }),
  );

/**
 * Same shape as Apply's lifecycle instrumentation: scoped artifacts +
 * instance id, the resource op metrics, and a `provider.<op>` span.
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
    Effect.serviceOption(ArtifactStore).pipe(
      Effect.map(Option.getOrElse(createArtifactStore)),
      Effect.flatMap((store) =>
        effect.pipe(
          Effect.provideService(Artifacts, makeScopedArtifacts(store, fqn)),
          Effect.provideService(InstanceId, instanceId),
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
    ) as Effect.Effect<A, E, Exclude<R, InstanceId | Artifacts>>;

export interface SyncPlan {
  /** Per-resource detection outcome (a dry-run {@link SyncResult}). */
  result: SyncResult;
  /**
   * The detection outcome projected onto the engine's {@link Plan} shape so
   * the CLI renders a sync exactly like a deploy plan (ink TUI when
   * interactive, plain logging otherwise): `drifted` → `update`, `missing` →
   * `create`, `unchanged`/`skipped` → `noop`.
   */
  plan: Plan;
}

/**
 * Run the drift-detection pass (a dry-run {@link sync}) and project the
 * outcome onto a {@link Plan} for display/approval. The plan is a read-only
 * view — repair happens by calling {@link sync} (without `dryRun`), which
 * re-observes the cloud rather than trusting the detection snapshot.
 */
export const plan = (stack: {
  name: string;
  stage: string;
}): Effect.Effect<SyncPlan, any, State> =>
  Effect.gen(function* () {
    const result = yield* sync(stack, { dryRun: true });
    const state = yield* yield* State;

    const resources: Plan["resources"] = {};
    for (const [fqn, r] of Object.entries(result.resources)) {
      const persisted = yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn,
      });
      if (!persisted || isActionState(persisted)) continue;
      const provider = yield* findProviderByType(persisted.resourceType);
      const action =
        r.action === "drifted"
          ? ("update" as const)
          : r.action === "missing"
            ? ("create" as const)
            : ("noop" as const);
      resources[fqn] = {
        action,
        props: persisted.props,
        state: persisted,
        provider,
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
          RuntimeContext: undefined!,
          Providers: undefined,
        } as ResourceLike,
        // Sync repairs from the persisted bindings verbatim — surface them
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
    } satisfies SyncPlan;
  }).pipe(
    Effect.withSpan("sync.plan", {
      attributes: {
        "alchemy.stack": stack.name,
        "alchemy.stage": stack.stage,
      },
    }),
  );
