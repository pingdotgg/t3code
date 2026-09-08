import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * A former id a resource was previously declared under:
 *
 * - a bare `string` resolves against the ambient namespace, exactly like
 *   the resource's own `id` argument does
 * - `{ fqn: "..." }` is absolute — the full FQN as persisted in state,
 *   ignoring any surrounding namespace. Needed when a resource moved
 *   BETWEEN namespaces (a relative id can only address the current
 *   namespace's subtree).
 */
export type FormerId = string | { fqn: string };

/**
 * RenamePolicy carries the former ids a resource was previously declared
 * under. It is captured from the ambient context at registration time (like
 * `AdoptPolicy` / `RemovalPolicy`) and resolved against the same namespace
 * as the resource's own id — see `ResourceLike.FormerFqns`.
 */
export class RenamePolicy extends Context.Service<
  RenamePolicy,
  readonly FormerId[]
>()("RenamePolicy") {}

/**
 * Declare the logical id(s) this resource was previously registered under,
 * so the engine migrates its persisted state row instead of planning a
 * create+delete replacement when the id changes.
 *
 * ```ts
 * // was: Bucket("Bucket") — the row migrates and the deploy plans a noop
 * const bucket = yield* Bucket("Assets").pipe(renamedFrom("Bucket"));
 * ```
 *
 * A bare string resolves against the ambient namespace, exactly like the
 * resource's own `id`:
 *
 * ```ts
 * // FQN `Site/Assets`, former FQN `Site/Bucket`
 * yield* Bucket("Assets").pipe(
 *   renamedFrom("Bucket"),
 *   Namespace.push("Site"),
 * );
 * ```
 *
 * Moved between namespaces? Pass `{ fqn }` — the absolute FQN exactly as
 * persisted in state, ignoring the ambient namespace:
 *
 * ```ts
 * // former FQN `LegacySite/Assets` (NOT `NewSite/LegacySite/Assets`)
 * yield* Bucket("Assets").pipe(
 *   renamedFrom({ fqn: "LegacySite/Assets" }),
 *   Namespace.push("NewSite"),
 * );
 * ```
 *
 * Renamed more than once? List every former id, most recent first — the
 * planner checks them in order and migrates from the first matching row:
 *
 * ```ts
 * // rename history: Bucket → StaticAssets → Assets
 * yield* Bucket("Assets").pipe(renamedFrom("StaticAssets", "Bucket"));
 * ```
 *
 * Migration semantics, by state-row shape (see Plan's rename resolution;
 * `new` = the row at the resource's FQN, `old` = a row at a former FQN):
 *
 * ```text
 * new                     old                     → outcome
 * ──────────────────────────────────────────────────────────────────────
 * —                       row                     → migrate: the old row
 *                                                   IS the resource's
 *                                                   state; apply moves it
 *                                                   before any lifecycle
 *                                                   op, and ONE update
 *                                                   reconcile re-brands
 *                                                   the physical resource
 *                                                   under the new logical
 *                                                   id (never a create)
 * row, same instanceId    row                     → interrupted
 *                                                   migration: leftovers
 *                                                   dropped state-only —
 *                                                   ALL of them in one
 *                                                   apply — the physical
 *                                                   resource is never
 *                                                   touched
 * row, diff instanceId    row                     → someone else's row (a
 *                                                   resource reused the
 *                                                   old name after the
 *                                                   rename shipped):
 *                                                   ignored, normal
 *                                                   orphan handling
 * row, diff resourceType  row                     → FATAL: migrating over
 *                                                   the foreign-typed row
 *                                                   would silently
 *                                                   abandon its cloud
 *                                                   resource — resolve
 *                                                   the collision first
 * any                     row, diff resourceType  → never migrated —
 *                                                   cannot be this
 *                                                   resource's row,
 *                                                   whatever its FQN says
 * ```
 *
 * The old id can be REUSED by a new resource in the same deploy — the
 * rename claim wins the row (it is an explicit statement that the row was
 * the renamer's), and the reusing resource is created fresh:
 *
 * ```ts
 * // `Assets` keeps the physical resource previously known as `Bucket`;
 * // this `Bucket` is a brand-new one.
 * yield* Bucket("Assets").pipe(renamedFrom("Bucket"));
 * yield* Bucket("Bucket");
 * ```
 *
 * Renames may SHIFT through each other in one deploy — each row follows
 * its resource (resolved in claim-dependency order):
 *
 * ```ts
 * // the resource at `A` is now `B`; the resource at `B` is now `C`
 * yield* Bucket("B").pipe(renamedFrom("A"));
 * yield* Bucket("C").pipe(renamedFrom("B"));
 * ```
 *
 * A SWAP (`A` ⇄ `B`) is a rename cycle and fails the plan loudly — the two
 * migrations would overwrite and delete each other's rows. Rename through
 * a temporary id across two deploys instead. Two resources claiming the
 * same former FQN also fail loudly.
 */
export const renamedFrom =
  (...formerIds: [FormerId, ...FormerId[]]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, RenamePolicy, formerIds);
