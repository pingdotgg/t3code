/** @effect-diagnostics anyUnknownInErrorContext:off */
/** @effect-diagnostics missingEffectError:off */
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
  type ReplaceDiff,
  type UpdateDiff,
} from "./Diff.ts";
import { parseFqn } from "./FQN.ts";
import { generateInstanceId, InstanceId } from "./InstanceId.ts";
import * as Output from "./Output.ts";
import {
  findProviderByType,
  missingProviderError,
  Provider,
  providerForMode,
  tryFindProviderByType,
  type ProviderService,
} from "./Provider.ts";
import {
  defaultProviderMode,
  stampedMode,
  type ProviderMode,
} from "./ProviderMode.ts";
import {
  isResource,
  missingImplementation,
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
import { isPlainData, mapPlainData } from "./Util/data.ts";
import { findCycleMembers } from "./Util/scc.ts";
import { hashInput } from "./Util/sha256.ts";

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
  /**
   * The {@link ProviderMode} this node's `provider` was resolved for.
   * `undefined` for mode-agnostic providers (a single implementation
   * serves both dev and deploy) — such resources never persist a mode and
   * never replace on a mode switch. Apply stamps this onto every state
   * commit as `providerMode`.
   */
  mode: ProviderMode | undefined;
  downstream: string[];
  bindings: BindingNode<R["Binding"]>[];
}

/**
 * Base for the apply-side nodes (create/update/replace/noop) — the nodes a
 * DECLARED resource plans to. Only these can carry a rename: a `Delete`
 * node is an orphaned row with no declaration, so nothing can claim to
 * have renamed it (migrating rows are excluded from the orphan pass
 * entirely).
 */
export interface ApplyNodeBase<
  R extends ResourceLike<string> = ResourceLike<string>,
> extends BaseNode<R> {
  /**
   * Set when this resource's persisted row was found under former FQNs
   * (`renamedFrom(...)`) — the migration source (no row at the current FQN
   * yet) and/or stale leftovers from interrupted migrations (same
   * `instanceId` as the resource's row; a rename chain with repeated
   * partial failures can leave several). Apply persists the move up-front,
   * before any lifecycle operation runs: commit `state` at the current
   * FQN, then delete every former row.
   */
  renamedFrom?: string[] | undefined;
}

export interface Create<
  R extends ResourceLike = ResourceLike,
> extends ApplyNodeBase<R> {
  action: "create";
  props: R["Props"];
  state: CreatingResourceState | undefined;
}

export interface Update<
  R extends ResourceLike = ResourceLike,
> extends ApplyNodeBase<R> {
  action: "update";
  /** True while this is the first reconcile after a cold adoption. */
  adopting?: boolean;
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
> extends ApplyNodeBase<R> {
  action: "noop";
  state: CreatedResourceState | UpdatedResourceState;
}

export interface Replace<
  R extends ResourceLike = ResourceLike,
> extends ApplyNodeBase<R> {
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
  /**
   * The run-level default {@link ProviderMode} this plan was built with
   * (`alchemy dev` → `"local"`, `alchemy deploy` → `"live"`). Renderers use
   * it to tag only the EXCEPTIONS — rows whose resolved mode differs from
   * the run default. `undefined` (plans built by older/auxiliary builders)
   * is treated as `"live"`.
   */
  defaultMode?: ProviderMode;
  /**
   * Marks a plan built by {@link destroy}. `apply` finishes a destroy plan
   * by deleting the stage's remaining persisted state — notably the stack
   * output record written by the last deploy — instead of persisting a new
   * (empty) output.
   */
  destroy?: boolean;
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

    // A bare platform tag yields a forward reference registered with
    // `undefined` props (and `RequiresImplementation`); its `.make(props,
    // impl)` Layer repairs the props when it builds (in either order — the
    // #874 circular env-tag pattern). Props still `undefined` after the
    // whole program evaluated means the tag was yielded but its Layer was
    // never provided — fail fast naming the class and its Layer instead of
    // letting a provider read `undefined` props (#1054). Plain resources
    // may legitimately be yielded without props (a reference to
    // already-deployed state), so the check is scoped to platform tags.
    for (const resource of resources) {
      if (resource.RequiresImplementation && resource.Props === undefined) {
        yield* Effect.die(
          missingImplementation(resource.Type, resource.LogicalId),
        );
      }
    }

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

    // The run-level default provider mode (`alchemy dev` → "local",
    // `alchemy deploy` → "live"). A resource-scoped `remote()` (captured on
    // the resource at registration as `Mode`) opts out of local emulation.
    const runDefaultMode = yield* defaultProviderMode;

    /**
     * Resolve the effective provider mode and the concrete provider
     * service for a resource.
     *
     * The mode only "sticks" when the provider actually distinguishes
     * modes (registered via `ProviderLayer.dual`). Mode-agnostic providers
     * satisfy any requested mode with their single implementation — in a
     * dev run, a construct that mixes emulatable resources with live-only
     * ones (e.g. R2 buckets) just works.
     */
    const resolveProviderAndMode = Effect.fn(function* (resource: {
      Type: string;
      Mode?: ProviderMode | undefined;
    }) {
      const base = yield* findProviderByType(resource.Type);
      const mode =
        base.modes !== undefined
          ? (resource.Mode ?? runDefaultMode)
          : undefined;
      const provider = yield* providerForMode(base, mode);
      return { provider, mode };
    });

    /**
     * Has this resource switched provider modes since it was last
     * reconciled? Rows without a persisted mode were written by a
     * pre-provider-mode engine (or a provider that only became dual-mode
     * later) — their physical resource is LIVE unless its attrs carry a
     * `dev:` identity marker proving it was reconciled locally (see
     * {@link stampedMode}). A dev run replaces unstamped live rows exactly
     * like stamped live rows; live runs replace unstamped marker rows.
     */
    const hasModeSwitched = (
      mode: ProviderMode | undefined,
      oldState: ResourceState | undefined,
    ): boolean =>
      mode !== undefined &&
      oldState !== undefined &&
      stampedMode(oldState) !== mode;

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

    // Snapshot of every persisted row, keyed by FQN. The rename resolution
    // below reads from this map instead of issuing per-FQN `state.get`s —
    // every renamedFrom-decorated resource (each StaticSite carries one
    // forever) would otherwise add two round-trips per resource to every
    // plan against a remote state store. Plan is read-only, so the
    // snapshot cannot go stale within this run.
    const persistedRows = new Map(
      resourceFqns.map((fqn, i) => [fqn, oldResources[i]]),
    );

    // ── FQN renames ──────────────────────────────────────────────────────
    // Map every former FQN claimed via `renamedFrom(...)` to its claimant's
    // current FQN. Two resources claiming the same former FQN is ambiguous
    // and fatal. A former FQN MAY still be actively declared — that is the
    // "old id reused by a new resource" case: the rename claim wins the
    // row (it is an explicit user statement that the row was theirs), and
    // the reusing resource plans a fresh create.
    const formerFqnClaims = new Map<string, string>();
    for (const resource of resources) {
      for (const formerFqn of resource.FormerFqns ?? []) {
        if (formerFqn === resource.FQN) continue;
        const claimant = formerFqnClaims.get(formerFqn);
        if (claimant !== undefined && claimant !== resource.FQN) {
          return yield* Effect.die(
            new Error(
              `Resources '${claimant}' and '${resource.FQN}' both claim ` +
                `former FQN '${formerFqn}' via renamedFrom(...). A former ` +
                "FQN can migrate to exactly one resource — remove the " +
                "decoration from one of them.",
            ),
          );
        }
        formerFqnClaims.set(formerFqn, resource.FQN);
      }
    }

    // Resolve every rename migration up-front against the state snapshot,
    // BEFORE any node is built — other resources' planning depends on the
    // outcome (a resource declared at a former FQN whose row is migrating
    // away must start from scratch).
    //
    // For each renamer, in former-id declaration order (most recent
    // first):
    //
    // - `source` is the row that defines the resource's physical identity:
    //   the row at its own FQN when present AND type-matching, otherwise
    //   the first type-matching former row (→ `moved`).
    // - every OTHER type-matching former row sharing `source.instanceId`
    //   is a leftover from an interrupted migration (only migration copies
    //   instanceIds) — collected for state-only cleanup.
    // - former rows with a different instanceId belong to someone else and
    //   are left to normal orphan handling; former rows with a different
    //   resourceType (modulo registered type-aliases) can never be this
    //   resource's row and are skipped entirely.
    // - a FOREIGN-typed row at the renamer's own FQN blocks the migration
    //   fatally: landing the migrated row there would silently abandon
    //   that row's cloud resource.
    const renameMigrations = new Map<
      string,
      { row: ResourceState; renamedFrom: string[]; moved: boolean }
    >();
    const migratedRowFqns = new Set<string>();

    const resolveRenamer = Effect.fn(function* (resource: ResourceLike) {
      const provider = Option.getOrUndefined(
        yield* tryFindProviderByType(resource.Type),
      );
      const allowedTypes = new Set([
        resource.Type,
        ...(provider?.aliases ?? []),
      ]);
      const persisted = persistedRows.get(resource.FQN);
      const persistedRow = isActionState(persisted)
        ? undefined
        : (persisted as ResourceState | undefined);
      // A row at this resource's own FQN that a PREVIOUSLY RESOLVED
      // renamer claimed (a same-deploy shift: A→B while B→C — C took the
      // row at B) is moving away: it is not ours to keep and it does not
      // block the migration landing here.
      const rowTaken = migratedRowFqns.has(resource.FQN);
      const ownRow =
        !rowTaken &&
        persistedRow !== undefined &&
        allowedTypes.has(persistedRow.resourceType)
          ? persistedRow
          : undefined;

      let source: ResourceState | undefined = ownRow;
      let adopted: ResourceState | undefined = ownRow;
      const renamedFrom: string[] = [];
      for (const formerFqn of resource.FormerFqns!) {
        if (formerFqnClaims.get(formerFqn) !== resource.FQN) continue;
        // The same former id may be listed twice (or resolve identically);
        // collect each former row once.
        if (renamedFrom.includes(formerFqn)) continue;
        const formerPersisted = persistedRows.get(formerFqn);
        if (formerPersisted === undefined || isActionState(formerPersisted)) {
          continue;
        }
        const formerRow = formerPersisted as ResourceState;
        if (!allowedTypes.has(formerRow.resourceType)) continue;
        if (source === undefined) {
          source = formerRow;
          adopted = {
            ...formerRow,
            fqn: resource.FQN,
            logicalId: resource.LogicalId,
            namespace: resource.Namespace,
          } as ResourceState;
          renamedFrom.push(formerFqn);
        } else if (source.instanceId === formerRow.instanceId) {
          renamedFrom.push(formerFqn);
        }
      }
      if (renamedFrom.length === 0) return;
      if (persistedRow !== undefined && ownRow === undefined && !rowTaken) {
        return yield* Effect.die(
          new Error(
            `Cannot migrate '${renamedFrom[0]}' to '${resource.FQN}': a ` +
              `state row of a different type ('${persistedRow.resourceType}') ` +
              `already occupies '${resource.FQN}'. Migrating over it would ` +
              "silently abandon that row's cloud resource. Delete or " +
              "rename the conflicting resource first, then re-deploy.",
          ),
        );
      }
      renameMigrations.set(resource.FQN, {
        row: adopted!,
        renamedFrom,
        moved: adopted !== ownRow,
      });
      for (const formerFqn of renamedFrom) migratedRowFqns.add(formerFqn);
    });

    // Resolve renamers in claim-dependency order: when resource R's OWN
    // FQN is claimed as a former id by resource S (a same-deploy shift:
    // A→B while B→C), S must resolve first — whether S takes R's row
    // decides whether R still owns it, or falls back to ITS former rows.
    // Iterate to fixpoint; anything left is a claim CYCLE (a swap: A⇄B),
    // which cannot be persisted safely — the migrations would overwrite
    // and delete each other's rows — and dies loudly.
    let pendingRenamers = resources.filter((r) => r.FormerFqns?.length);
    const resolvedRenamers = new Set<string>();
    while (pendingRenamers.length > 0) {
      const ready = pendingRenamers.filter((resource) => {
        const claimant = formerFqnClaims.get(resource.FQN);
        return claimant === undefined || resolvedRenamers.has(claimant);
      });
      if (ready.length === 0) {
        return yield* Effect.die(
          new Error(
            `Rename cycle detected among [${pendingRenamers
              .map((r) => `'${r.FQN}'`)
              .join(
                ", ",
              )}]: their renamedFrom(...) declarations claim each other's ` +
              "FQNs. Swapping ids in one deploy is not supported — rename " +
              "through a temporary id across two deploys instead.",
          ),
        );
      }
      for (const resource of ready) {
        yield* resolveRenamer(resource);
        resolvedRenamers.add(resource.FQN);
      }
      pendingRenamers = pendingRenamers.filter(
        (r) => !resolvedRenamers.has(r.FQN),
      );
    }

    /**
     * Fetch the persisted row for a declared resource, resolving renames
     * (see the pre-computed `renameMigrations` above):
     *
     * - a renamer plans from its migrated row (`renamedFrom` rides onto
     *   the plan node; apply persists the move before any lifecycle op)
     * - a resource declared at a former FQN whose row is migrating away
     *   starts from scratch — the row is NOT its state, whatever the FQN
     *   says
     */
    const getPersistedRow = Effect.fn(function* (
      resource: Pick<ResourceLike, "FQN">,
    ) {
      const migration = renameMigrations.get(resource.FQN);
      if (migration !== undefined) {
        return {
          row: migration.row,
          renamedFrom: migration.renamedFrom,
          renameMoved: migration.moved,
        };
      }
      const persisted = yield* state.get({
        stack: stackName,
        stage: stage,
        fqn: resource.FQN,
      });
      const row = isActionState(persisted)
        ? undefined
        : (persisted as ResourceState | undefined);
      if (row !== undefined && migratedRowFqns.has(resource.FQN)) {
        return { row: undefined, renamedFrom: undefined, renameMoved: false };
      }
      return { row, renamedFrom: undefined, renameMoved: false };
    });

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

              const { provider, mode } =
                yield* resolveProviderAndMode(resource);
              const props = materializeStableRefs(
                yield* resolveInput(resource.Props),
              );
              // Falls back to the row at a former FQN (`renamedFrom`) so a
              // renamed resource's stable attributes keep flowing to
              // downstream diffs across the migration.
              const { row: oldState } = yield* getPersistedRow(resource);

              if (!oldState || oldState.status === "creating") {
                return resourceExpr;
              }

              // The resource is switching provider modes (local ⇄ live):
              // it will be replaced, so nothing about the persisted attrs
              // is stable for downstream consumers.
              if (hasModeSwitched(mode, oldState)) {
                return resourceExpr;
              }

              const oldProps =
                oldState.status === "updating"
                  ? oldState.old.props
                  : oldState.props;

              // Normalize both sides through `dedupeBindings` so the binding
              // sets handed to `diff` are deduped AND sid-sorted — provider
              // diffs that hash/compare the arrays never churn on
              // registration-order flips (or on legacy unsorted state).
              const oldBindings = dedupeBindings(oldState.bindings ?? []);
              const newBindings = dedupeBindings(
                stack.bindings[resource.FQN] ?? [],
              );

              const diff = yield* provider.diff
                ? provider
                    .diff({
                      id: resource.LogicalId,
                      fqn: resource.FQN,
                      olds: oldProps,
                      instanceId: oldState.instanceId,
                      news: props,
                      output: oldState.attr,
                      oldBindings,
                      newBindings,
                    })
                    .pipe(providePlanScope(resource.FQN, oldState.instanceId))
                : Effect.succeed(undefined);

              // A present `diff.stables` is authoritative for this update and
              // overrides `provider.stables`. We only fall back to the
              // provider-level "always stable" list when the diff does not
              // return one (e.g. no diff fn, or a diff that omits `stables`).
              const stables: string[] = diff?.stables ?? provider.stables ?? [];

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
              // `--force` upgrades this resource's noop to an update (see the
              // diff mapping in the resource-graph pass below), so its
              // `reconcile` WILL re-run and may produce fresh attributes —
              // that is the point of --force. Returning the persisted attr
              // snapshot here would bake potentially-stale values into every
              // consumer's plan props and binding data, so consumers would
              // keep the stale attrs even though the upstream just
              // re-reconciled. Expose only the stable attributes and let
              // apply re-evaluate the rest against the forced reconcile's
              // fresh output.
              if (options.force) {
                return withStables(oldState?.attr);
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

    /**
     * Resolve an input value as far as *truth* permits, keeping everything
     * else evaluable. A whole-resource reference to an updating upstream
     * stays a `ResourceExpr` (its stable attributes riding along): the
     * non-stable attributes are unknown at plan time and MUST be
     * re-evaluated — Apply runs `Output.evaluate(node.props, outputs)`
     * against the upstream's fresh post-reconcile attributes right before
     * `reconcile`. This is the value plan nodes carry; the diff-facing view
     * is derived from it by {@link materializeStableRefs}.
     */
    const resolveInput = (
      input: any,
      // Ancestor chain of the current walk. A value that appears on its own
      // ancestor path is a true cycle and is cut to `undefined` (a cycle can
      // never persist or serialize anyway); an immutable per-level set (not
      // a shared visited-set) keeps legitimately-shared diamond references
      // intact and is race-free under `concurrency: "unbounded"` (#1082).
      ancestors: ReadonlySet<object> = new Set(),
    ): Effect.Effect<any, Config.ConfigError> =>
      Effect.gen(function* () {
        if (!input) {
          return input;
        } else if (Output.isExpr(input)) {
          return yield* resolveOutput(input);
        } else if (Config.isConfig(input)) {
          // Config is a lazy reference to the deploy environment. Resolve it
          // here so the concrete value flows into diffing/hashing (an opaque
          // Config hashes the same regardless of the underlying value) and so
          // providers receive a resolved value instead of a Config object.
          // `Config.redacted` resolves to a `Redacted`, which stays opaque via
          // the branch below.
          return yield* resolveInput(yield* input, ancestors);
        } else if (isResource(input)) {
          // Resource objects have dynamic properties (path, hash, etc.) that are
          // created on-demand by a Proxy getter and aren't enumerable via Object.entries.
          // Resolve the ResourceExpr to get the actual resource output, then continue
          // resolving any nested outputs in the result.
          const resourceExpr = Output.of(input);
          const resolved = yield* resolveOutput(resourceExpr);
          if (Output.isResourceExpr(resolved)) {
            // Still-unresolved reference (creating, replacing, or updating
            // upstream) — keep it evaluable for Apply.
            return resolved;
          }
          return yield* resolveInput(resolved, ancestors);
        } else if (isPlainData(input)) {
          if (ancestors.has(input)) {
            return undefined;
          }
          const nested = new Set(ancestors).add(input);
          if (Array.isArray(input)) {
            return yield* Effect.all(
              input.map((item) => resolveInput(item, nested)),
              { concurrency: "unbounded" },
            );
          }
          return Object.fromEntries(
            yield* Effect.all(
              Object.entries(input).map(([key, value]) =>
                resolveInput(value, nested).pipe(
                  Effect.map((value) => [key, value]),
                ),
              ),
              { concurrency: "unbounded" },
            ),
          );
        }
        // Everything else is an opaque leaf returned by identity: Duration,
        // Redacted, Date, and effect runtime values (a Worker's `exports`
        // carries each DO's `constructor` Effect and captured `services`
        // Context). Rebuilding a class instance entry-by-entry would strip
        // its prototype, and effect ≥4.0.0-beta.103's Context is cyclic
        // (#1082). Redacted additionally stays wrapped to preserve the
        // secrecy boundary. This sits after `Config.isConfig` on purpose —
        // Configs are Effects but must still resolve.
        return input;
      });

    /**
     * Project a {@link resolveInput} resolution into the DIFF-facing view:
     * replace each whole-resource `ResourceExpr` that carries stable
     * attributes (an upstream being *updated* in place — see `withStables` in
     * `resolveResource`) with a plain object of those stables, so the known
     * values flow into the consumer's `diff` and `havePropsChanged` instead
     * of the whole reference looking unresolved and `isResolved`
     * short-circuiting (#670 — this forced the Neon `Branch` to hand-extract
     * `project.projectId`).
     *
     * The projection is deliberately lossy — diffs compare VALUES. Plan nodes
     * never carry it: they keep the evaluable resolution so `reconcile` sees
     * the upstream's fresh non-stable attributes (e.g. a Lambda Version's
     * `version` number — #993's alias promotion bug).
     */
    const materializeStableRefs = (
      input: any,
      // Ancestor-path cycle guard — see resolveInput (#1082). Sync DFS, so
      // add/delete around the recursion is race-free.
      ancestors: WeakSet<object> = new WeakSet(),
    ): any => {
      // Expr checks come first: Output proxies are callable, so a plain
      // `typeof input === "object"` guard would let them slip through.
      if (Output.isResourceExpr(input) && input.stables) {
        return materializeStableRefs(input.stables, ancestors);
      } else if (Output.isExpr(input)) {
        // Genuinely unknown (e.g. a creating upstream) — nothing to show diff.
        return input;
      } else if (!input || !isPlainData(input)) {
        // Primitives and non-plain instances (Duration, Redacted, Date,
        // Effect/Layer/Context) are leaves — see isPlainData (#1082).
        return input;
      }
      return mapPlainData(input, ancestors, (child) =>
        materializeStableRefs(child, ancestors),
      );
    };

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
            // An Action depends on the resources referenced by its Input *and*
            // any Output captured via `yield* output` inside its init Effect.
            Array.from(
              new Set([
                ...Object.values(Output.upstreamAny(action.Input)).map(
                  (r) => r.FQN,
                ),
                ...Object.values(Output.upstreamAny(action.Captures)).map(
                  (r) => r.FQN,
                ),
              ]),
            ),
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
      // Actions have no bindings — their upstream is input + init captures,
      // both already folded into newUpstreamDependencies above.
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
            const { provider, mode } = yield* resolveProviderAndMode(resource);
            const id = resource.LogicalId;
            const fqn = resource.FQN;
            // Apply-facing props (stored on the plan node): whole-resource
            // references to updating upstreams stay evaluable `ResourceExpr`s.
            // Apply runs `Output.evaluate(node.props, outputs)` right before
            // `reconcile`, so these references resolve to the upstream's
            // fresh post-reconcile attributes.
            const applyProps = yield* resolveInput(resource.Props);
            // Diff-facing view of the same resolution: stable attributes
            // materialized so their known values flow into `diff` /
            // `havePropsChanged`.
            const news = materializeStableRefs(applyProps);
            const downstream = newDownstreamDependencies[fqn] ?? [];

            // Apply-facing binding rows, mirroring `applyProps`: payloads
            // whose data embeds a whole-resource reference to an updating
            // upstream keep it as an evaluable `ResourceExpr`. Apply runs
            // `Output.evaluate(node.bindings, outputs)` right before
            // `reconcile`, so the host receives the upstream's fresh
            // post-reconcile attributes. Collapse duplicates by sid so the
            // binding set handed to `diff` matches what `reconcile` receives
            // (see `dedupeBindings`).
            const applyBindings: ResourceBinding[] = dedupeBindings(
              yield* resolveInput(stack.bindings[fqn] ?? []),
            );
            // Diff-facing view of the same rows: stable attributes
            // materialized so `diffBindings` / `provider.diff` compare known
            // values. Terminal commits still persist the payload the provider
            // actually reconciled with (#874) — Apply commits the evaluated
            // `bindingOutputs`, not these plan-time shapes.
            const newBindings: ResourceBinding[] =
              materializeStableRefs(applyBindings);
            // The row is looked up at the resource's FQN with a fallback to
            // its former FQNs (`renamedFrom`); a row found under a former
            // FQN arrives here already remapped to the new identity, and
            // `renamedFrom` rides onto the plan node so apply persists the
            // move. (A Task previously holding this FQN is treated as no
            // prior state — its row is reaped by `actionDeletions` below.)
            const {
              row: persistedRow,
              renamedFrom,
              renameMoved,
            } = yield* getPersistedRow(resource);
            let oldState: ResourceState | undefined = persistedRow;

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
            //   - owned                          → adopt the `created` state
            //                                      from attrs and continue
            //                                      through the normal diff
            //                                      path (so subsequent props
            //                                      drift produces an update).
            //   - unowned + adopt enabled        → take over: adopt the
            //                                      `created` state and let the
            //                                      next update overwrite tags.
            //   - unowned + adopt disabled       → fail with
            //                                      `OwnedBySomeoneElse`.
            //
            // Plan construction is side-effect-free: the adopted `created`
            // state is only held in-memory here (to drive the diff) and rides
            // onto the plan node as `node.state`. Persisting it to the state
            // store happens exclusively during APPLY of that node (the update
            // lifecycle commits `updating` / `updated` carrying this state).
            // If planning persisted here, a mere `alchemy plan` / `--dry-run`
            // would claim ownership of an unowned cloud resource, arming a
            // later unrelated deploy to orphan-delete it. See
            // https://github.com/alchemy-run/alchemy/issues/793.
            //
            // After a cold-start adoption (engine just discovered an
            // existing cloud resource via `read`), force the engine's
            // normal `update` path so the provider can re-sync ownership
            // tags, configuration, etc. against the desired props.
            // Adoption carries state with `props: news`, so the default
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
            // A resource declared at a former FQN whose row just migrated
            // away is genuinely NEW by declaration — skip the probe. Its
            // predecessor's physical resource still carries tags branded
            // with THIS logical id (the migrated row's reconcile hasn't
            // re-branded them yet), so a tag-based `read` would find it
            // and silently adopt the very resource that was renamed away.
            const reusesMigratedFqn = migratedRowFqns.has(fqn);
            let forceUpdateAfterAdoption = false;
            if (
              oldState === undefined &&
              provider.read &&
              isResolved(news) &&
              !reusesMigratedFqn
            ) {
              const adoptInstanceId = yield* generateInstanceId();
              const readResult = yield* provider
                .read({
                  id,
                  fqn,
                  instanceId: adoptInstanceId,
                  olds: news,
                  output: undefined,
                })
                .pipe(providePlanScope(fqn, adoptInstanceId));
              if (readResult !== undefined) {
                const isUnowned = Unowned.is(readResult);
                // A resource-scoped `adopt(...)` (captured on the resource at
                // registration) overrides the stack/CLI default.
                const adoptThis = resource.Adopt ?? (yield* shouldAdopt);
                if (isUnowned && !adoptThis) {
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
                  providerMode: mode,
                } satisfies CreatedResourceState;
                // In-memory only — do NOT persist here. Plan.make runs for
                // `alchemy plan` / `deploy --dry-run` too, so a `state.set`
                // would mutate persistent state during a read-only preview.
                // The adopted state rides onto the plan node via `oldState`
                // (→ `node.state`) and is persisted at APPLY time by the
                // update lifecycle's `updating` / `updated` commits. See
                // https://github.com/alchemy-run/alchemy/issues/793.
                oldState = adoptedState;
                forceUpdateAfterAdoption = true;
              }
            }

            // Sid-sorted like `newBindings` (see the resolveResource note).
            const oldBindings = dedupeBindings(oldState?.bindings ?? []);
            // Actions come from the materialized comparison (`newBindings`);
            // the payloads the node carries into Apply come from the
            // apply-faithful rows, joined by sid — both are views of the same
            // deduped `stack.bindings[fqn]` rows, so action and payload can
            // never drift. `delete` rows keep the persisted old data.
            const applyBindingData = new Map(
              applyBindings.map((b) => [b.sid, b.data]),
            );
            const bindingDiffs = diffBindings(oldBindings, newBindings).map(
              (b) =>
                b.action === "delete" || !applyBindingData.has(b.sid)
                  ? b
                  : { ...b, data: applyBindingData.get(b.sid) },
            );

            // Local ⇄ live switch: the persisted row was reconciled by a
            // different provider mode than the one resolved for this run.
            // The two runtimes host distinct physical instances, so this is
            // always a replacement — the new instance is created with the
            // new mode's provider, and Apply deletes the old generation
            // with the provider of the mode that created it (see
            // `deleteOldGenerations` / `collectGarbage`).
            const modeSwitched = hasModeSwitched(mode, oldState);

            const Node = <T extends Apply>(
              node: Omit<
                T,
                "provider" | "resource" | "bindings" | "downstream" | "mode"
              >,
            ) =>
              ({
                ...node,
                provider,
                resource,
                bindings: bindingDiffs,
                downstream,
                mode,
                renamedFrom,
              }) as any as T;

            // Plan against the persisted state we have, not the ideal final state we
            // hoped to reach last time. Recovery is expressed by mapping each
            // intermediate state back onto a fresh CRUD action.
            if (oldState === undefined) {
              return Node<Create>({
                action: "create",
                props: applyProps,
                state: oldState,
              });
            } else if (
              !modeSwitched &&
              oldState.status === "creating" &&
              oldState.attr === undefined
            ) {
              // A create may have succeeded before state persistence failed. If the
              // provider can recover an attribute snapshot, keep driving the same
              // create instead of starting over blindly.
              //
              // `creating` state persists the RAW plan-time props, which may
              // still contain unresolved Output expressions (e.g. a name
              // referencing an upstream created in the same failed deploy).
              // `read` implementations derive identity from `olds` when
              // `output` is undefined (as it is here), so handing them
              // unresolved exprs crashes. Skip the probe — same behavior as
              // a read that found nothing — and re-drive the create.
              if (provider.read && isResolved(oldState.props)) {
                const attr = yield* provider
                  .read({
                    id,
                    fqn,
                    instanceId: oldState.instanceId,
                    olds: oldState.props,
                    output: oldState.attr,
                  })
                  .pipe(
                    providePlanScope(fqn, oldState.instanceId),
                    // `creating` props pass `isResolved` yet can still carry
                    // holes where unresolved Outputs were stripped at commit
                    // time (see stripUnresolved) — e.g. a parent reference
                    // persisted as `{}`. A provider that dereferences one
                    // crashes deep inside its SDK client (a SchemaError
                    // defect), which would brick every subsequent plan on
                    // the stage. Recovery is best-effort: degrade the defect
                    // to "nothing recovered" and re-drive the create (#995).
                    Effect.catchDefect((defect) =>
                      Effect.logWarning(
                        `Recovery read for '${fqn}' crashed; treating the ` +
                          "interrupted create as not recoverable and " +
                          "re-driving it.",
                        defect,
                      ).pipe(Effect.as(undefined)),
                    ),
                  );
                if (attr !== undefined) {
                  // The recovered resource may be foreign: our interrupted
                  // create could have lost a name race, or died before
                  // stamping ownership. Route `Unowned` through the same
                  // adoption table as the cold-start probe above — never
                  // silently take over (and later mutate/delete) a resource
                  // we cannot prove we created.
                  if (Unowned.is(attr)) {
                    const adoptThis = resource.Adopt ?? (yield* shouldAdopt);
                    if (!adoptThis) {
                      return yield* new OwnedBySomeoneElse({
                        message:
                          `Cannot resume creating resource '${fqn}' ` +
                          `(${resource.Type}): a resource with its physical ` +
                          "identity exists in the cloud but is not owned by " +
                          "this stack/stage/logical-id. Re-run with `--adopt` " +
                          "(or wrap the effect in `adopt(true)`) to take it " +
                          "over.",
                        resourceType: resource.Type,
                        logicalId: id,
                      });
                    }
                  }
                  // Continue through the normal diff below with the recovered
                  // live snapshot. Desired props may have changed while the
                  // previous create was interrupted; bypassing diff here can
                  // drive an immutable change through reconcile and falsely
                  // persist the old physical resource as converged.
                  oldState = { ...oldState, attr: stripUnowned(attr) };
                }
              }
            }

            // Diff against whatever props represent the best-known current attempt.
            // For replacement recovery that means the top-level replacement props,
            // not the older generations stored under `old`.
            const oldProps = oldState.props;

            // On a mode switch the provider diff is skipped entirely:
            // comparing props across runtimes is meaningless (and the new
            // mode's provider has never seen the old mode's state). The
            // action is a replacement by definition.
            const diff = modeSwitched
              ? ({
                  action: "replace",
                  deleteFirst: false,
                } satisfies ReplaceDiff)
              : yield* asEffect(
                  provider
                    ?.diff?.({
                      id,
                      fqn,
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
                  //
                  // A row that just migrated from a former FQN (`renameMoved`)
                  // gets the same treatment: its cloud resource is still
                  // branded with the OLD logical id's tags, and if the old id
                  // is being reused by a new resource, leaving them stale
                  // would let the reuser's future adoption probes match the
                  // wrong physical resource.
                  Effect.map((diff) =>
                    (forceUpdateAfterAdoption || renameMoved) &&
                    diff.action === "noop"
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
                  props: applyProps,
                  state: oldState,
                });
              } else if (diff.action === "update") {
                // props have changed in a way that is updatable
                // again, just continue with the create
                // TODO(sam): should we maybe try an update instead?
                return Node<Create>({
                  action: "create",
                  props: applyProps,
                  state: oldState,
                });
              } else {
                // props have changed in an incompatible way
                // because it's possible that an un-updatable resource has already been created
                // we must use a replace step to create a new one and delete the potential old one
                return Node<Replace>({
                  action: "replace",
                  props: applyProps,
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
                  props: applyProps,
                  state: oldState,
                });
              } else {
                // we started to update a resource but now believe we should replace it
                return Node<Replace>({
                  action: "replace",
                  deleteFirst: diff.deleteFirst ?? false,
                  props: applyProps,
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
                  props: applyProps,
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
                  props: applyProps,
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
                  props: applyProps,
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
                  props: applyProps,
                  state: oldState,
                });
              } else if (diff.action === "update") {
                // the replacement has been created but now also needs to be updated
                // the resource provider should:
                // 1. Update the newly created replacement resource
                // 2. Then proceed as normal to delete the replaced resources (after all downstream references are updated)
                return Node<Update>({
                  action: "update",
                  props: applyProps,
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
                  props: applyProps,
                  state: oldState,
                });
              }
            } else if (oldState.status === "deleting") {
              // we're in a partially deleted state, it is unclear whether it was or was not deleted
              // so continue by re-creating it with the same instanceId and desired props
              return Node<Create>({
                action: "create",
                props: applyProps,
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
                adopting: forceUpdateAfterAdoption,
                props: applyProps,
                state: oldState,
              });
            } else if (diff.action === "replace") {
              return Node<Replace>({
                action: "replace",
                props: applyProps,
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
            // The node carries the RAW input expression (evaluated at apply);
            // the drift hash uses the diff-facing view so stable upstream
            // attributes hash as their known values.
            const resolvedInput = materializeStableRefs(
              yield* resolveInput(action.Input),
            );
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
                  Captures: {},
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
            if (oldState) {
              // A row being migrated by a rename (`renameMigrations`) is
              // moving, not orphaned — apply drops it state-only after
              // committing the migrated row at its new FQN. Rows at former
              // FQNs that did NOT migrate (foreign type, different
              // instanceId, unclaimed) are absent from this set and fall
              // through to normal orphan deletion.
              if (migratedRowFqns.has(fqn)) {
                return;
              }
              const { logicalId } = parseFqn(fqn);
              const resourceType = oldState.resourceType;
              // A "zombie" row references a type with no registered provider
              // (removed from the program, or renamed without an alias).
              // That is fatal: the program and state disagree, and without
              // the provider the row's physical resource cannot be deleted
              // anyway. Die at plan time with a typed error naming the row
              // and the remediation instead of limping into a partial apply.
              //
              // Orphan deletes resolve the provider variant for the mode
              // that created the row (`providerMode`, or the `dev:` marker
              // inference for legacy unstamped rows), so e.g. a local dev
              // worker's row is deleted by the local provider even during a
              // live deploy — and vice versa. Unstamped rows are physically
              // live unless their attrs carry the marker (see stampedMode),
              // never the run default.
              const rowMode = stampedMode(oldState);
              const providerOption = yield* tryFindProviderByType(
                resourceType,
                rowMode,
              );
              if (Option.isNone(providerOption)) {
                return yield* Effect.die(
                  missingProviderError(resourceType, fqn),
                );
              }
              const provider = providerOption.value;
              // NOTE: an attr-less row (interrupted create) is NOT recovered
              // here. Apply's `deleteResource` performs the authoritative
              // read-then-delete recovery — it also covers replaced-chain
              // old generations that never pass through plan, and routes
              // `Unowned` results away from `provider.delete`.
              return [
                fqn,
                {
                  action: "delete",
                  state: oldState,
                  provider: provider,
                  mode: oldState.providerMode,
                  resource: {
                    Namespace: oldState.namespace,
                    FQN: fqn,
                    LogicalId: logicalId,
                    Type: oldState.resourceType,
                    Attributes: oldState.attr,
                    Props: oldState.props,
                    Binding: undefined!,
                    Provider: Provider(resourceType),
                    RemovalPolicy: oldState.removalPolicy,
                    Adopt: undefined,
                    RequiresImplementation: undefined,
                    Mode: oldState.providerMode,
                    FormerFqns: undefined,
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
      defaultMode: runDefaultMode,
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

/**
 * Build the plan that destroys every resource of `(stack.name, stack.stage)`.
 *
 * The spec is emptied out so every persisted resource becomes an orphan
 * deletion, and `output` is left undefined so `apply` does not overwrite the
 * last deploy's persisted stack output with an empty husk. `apply` recognizes
 * the `destroy` marker and deletes the stage's remaining persisted state (the
 * stack output record) once the destroy has converged, so `state.getOutput`
 * and `state.listStages` agree the stage is gone.
 *
 * @see https://github.com/alchemy-run/alchemy/issues/961
 */
export const destroy = (stack: {
  name: string;
  stage: string;
}): Effect.Effect<Plan<undefined>, never, State> =>
  make({
    name: stack.name,
    stage: stack.stage,
    resources: {},
    bindings: {},
    actions: {},
    output: undefined,
  }).pipe(Effect.map((plan) => ({ ...plan, destroy: true })));

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
    const renamed = node.renamedFrom?.length
      ? ` (renamed from ${node.renamedFrom.join(", ")})`
      : "";
    lines.push(`│ [${symbol}] ${id} (${type})${downstream}${renamed}`);
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
