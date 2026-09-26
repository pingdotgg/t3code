/** @effect-diagnostics anyUnknownInErrorContext:off */
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
import {
  noopSession,
  Progress,
  type PlanStatusSession,
  type ScopedPlanStatusSession,
} from "./Report.ts";
import { deepEqual } from "./Diff.ts";
import { InstanceId } from "./InstanceId.ts";
import type { Apply, Plan } from "./Plan.ts";
import { findProviderByType, Provider } from "./Provider.ts";
import { stampedMode } from "./ProviderMode.ts";
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

export interface DriftOptions {
  /** Optional progress session (the CLI passes one; tests usually don't). */
  session?: PlanStatusSession;
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
 * Resources are checked concurrently and independently — persisted props are
 * fully resolved values, so there are no upstream/downstream data edges to
 * order by. A failure checking one resource does not interrupt the others;
 * all failures are aggregated into a single combined cause after every
 * resource has been attempted.
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
  options: DriftOptions & { readonly dryRun: boolean },
): Effect.Effect<DriftResult, any, State> =>
  Effect.gen(function* () {
    // Phase markers + per-resource observation progress go through the
    // ambient Progress reporter (a no-op by default) so renderers can show the
    // drift check as it runs.
    const reportPlanned = yield* Progress;
    yield* reportPlanned({ _tag: "plan.phase", phase: "loading-state" });
    const state = yield* yield* State;
    const session = options.session ?? noopSession;
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

      const scopedSession = {
        ...session,
        note: (note, options?) =>
          session.emit({
            fqn,
            id: logicalId,
            _tag: "apply.resource.note",
            message: note,
            kind: options?.kind,
          }),
      } satisfies ScopedPlanStatusSession;

      const report = (
        status: "updating" | "updated" | "creating" | "created" | "skipped",
      ) =>
        session.emit({
          _tag: "apply.resource.status",
          fqn,
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
      const provider = yield* findProviderByType(
        resourceType,
        stampedMode(old),
      );
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

      // Paired with the resource-planned completion so renderers can show
      // which rows' cloud reads are actually in flight (the slowest part of
      // a drift check). Emitted after the skip gates: skipped rows settle
      // instantly and never read the cloud.
      yield* reportPlanned({
        _tag: "plan.resource.started",
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
    yield* reportPlanned({ _tag: "plan.phase", phase: "computing-plan" });

    // Per-resource observation progress: each row is reported through the
    // ambient Progress reporter as its cloud read lands (drift checks are the
    // slowest planning path). Failed or action rows advance the count
    // without an event, so progress stays monotonic.
    const observedCount = yield* Ref.make(0);
    const resourceObserved = (result: DriftResourceResult | undefined) =>
      Ref.updateAndGet(observedCount, (count) => count + 1).pipe(
        Effect.flatMap((completed) =>
          result === undefined
            ? Effect.void
            : reportPlanned({
                _tag: "plan.resource.completed",
                fqn: result.fqn,
                logicalId: result.logicalId,
                resourceType: result.resourceType,
                // Drift observation compares attributes, not binding rows.
                bindings: [],
                action:
                  result.action === "drifted" || result.action === "repaired"
                    ? "update"
                    : result.action === "missing"
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
    const results = yield* Effect.all(
      fqns.map((fqn) =>
        driftResource(fqn).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              failures.push(cause);
              const persisted = yield* state
                .get({ stack: stackName, stage, fqn })
                .pipe(Effect.orElseSucceed(() => undefined));
              if (persisted && !isActionState(persisted)) {
                yield* session.emit({
                  _tag: "apply.resource.status",
                  fqn,
                  id: persisted.logicalId,
                  type: persisted.resourceType,
                  status: "fail",
                });
              }
              return undefined;
            }),
          ),
          Effect.tap(resourceObserved),
        ),
      ),
      { concurrency: "unbounded" },
    );

    yield* session.done(failures.length === 0 ? "success" : "failure");

    if (failures.length > 0) {
      return yield* Effect.failCause(
        failures.reduce(Cause.combine) as Cause.Cause<never>,
      );
    }

    return {
      resources: Object.fromEntries(
        results
          .filter((r): r is DriftResourceResult => r !== undefined)
          .map((r) => [r.fqn, r]),
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
export const detect = (stack: { name: string; stage: string }) =>
  runDrift(stack, { dryRun: true });

/** Reconcile resources back to their last-deployed desired state. */
export const repair = (
  stack: { name: string; stage: string },
  options: DriftOptions = {},
) => runDrift(stack, { ...options, dryRun: false });

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
  ): Effect.Effect<
    A,
    E | DriftResourceError,
    Exclude<R, InstanceId | Artifacts>
  > =>
    Effect.serviceOption(ArtifactStore).pipe(
      Effect.map(Option.getOrElse(createArtifactStore)),
      Effect.flatMap((store) =>
        effect.pipe(
          Effect.provideService(Artifacts, makeScopedArtifacts(store, fqn)),
          Effect.provideService(InstanceId, instanceId),
          Effect.catchCause(
            (cause): Effect.Effect<never, E | DriftResourceError> =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.fail(
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
    ) as Effect.Effect<
      A,
      E | DriftResourceError,
      Exclude<R, InstanceId | Artifacts>
    >;

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
      const provider = yield* findProviderByType(
        persisted.resourceType,
        stampedMode(persisted),
      );
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
