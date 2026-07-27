import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Input } from "./Input.ts";
import * as Output from "./Output.ts";
import type { BindingNode } from "./Plan.ts";
import type { ResourceBinding } from "./Resource.ts";
import { isPrimitive } from "./Util/data.ts";

export type Diff = NoopDiff | UpdateDiff | ReplaceDiff;

export interface NoopDiff {
  action: "noop";
  stables?: undefined;
}

export interface UpdateDiff {
  action: "update";
  /** properties that won't change as part of this update */
  stables?: string[];
}

export interface ReplaceDiff {
  action: "replace";
  deleteFirst?: boolean;
  stables?: undefined;
}

/**
 * Returns true when `value` (or any nested leaf) is still an unresolved
 * plan-time expression — i.e. an `Output`/`Expr` or an `Effect` that was
 * not fully evaluated by `resolveInput` in Plan.ts.
 *
 * Use at the top of a provider `diff` to short-circuit before field access:
 *
 * ```ts
 * if (!isResolved(news)) return undefined;
 * const resolved = news as MyProps;
 * ```
 */
export const hasUnresolvedInputs = <T>(value: Input<NoInfer<T>>): value is T =>
  _hasUnresolved(value);

export const isResolved = <T>(value: Input<T>): value is T =>
  !_hasUnresolved(value);

const _hasUnresolved = (value: unknown): boolean => {
  if (value == null || isPrimitive(value)) return false;
  if (Output.isExpr(value) || Effect.isEffect(value)) return true;
  if (Array.isArray(value)) return value.some(_hasUnresolved);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(_hasUnresolved);
  }
  return false;
};

/**
 * Deeply replace every unresolved plan-time expression (an `Output`/`Expr`
 * or an un-evaluated `Effect`) with `undefined`, leaving resolved values
 * (including opaque `Redacted`/`Duration` instances) intact.
 *
 * Persisted resource state must only ever hold plain data. Durable (JSON)
 * state stores already enforce this implicitly — Output proxies are
 * function-typed, so `JSON.stringify` silently drops them — but the
 * in-memory store used by tests retains live proxies, which would later be
 * fed back into provider lifecycle operations as `olds` after an
 * interrupted apply (e.g. `read` during a destroy plan) and blow up on
 * first string coercion. Sanitizing at the commit boundary keeps both
 * store kinds consistent with the provider contract that `olds` is
 * resolved `Props`.
 */
export const stripUnresolved = <T>(value: T): T => _stripUnresolved(value) as T;

const _stripUnresolved = (value: unknown): unknown => {
  if (value == null || isPrimitive(value)) return value;
  if (Output.isExpr(value) || Effect.isEffect(value)) return undefined;
  // Opaque resolved values — rebuilding them structurally would strip
  // their prototype (see resolveInput in Plan.ts for the same rule).
  if (Redacted.isRedacted(value) || Duration.isDuration(value)) return value;
  if (Array.isArray(value)) return value.map(_stripUnresolved);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, _stripUnresolved(item)]),
    );
  }
  return value;
};

/**
 * Deeply replace Effect-valued entries with `undefined`, leaving resolved
 * values AND unresolved `Output`/`Expr`s intact.
 *
 * Effect-valued props — e.g. a tagged Worker class in `env` (the
 * circular-bindings pattern) — can never be evaluated inside lifecycle
 * operations, and {@link stripUnresolved} drops them from persisted state at
 * the commit boundary. A provider `diff` that wants its structural change
 * detection to still run despite them strips them first, so `isResolved`
 * gates only on genuinely-unresolved Outputs (#874). The Effects' deploy-time
 * identity is carried by the resolved binding data instead.
 */
export const stripEffects = <T>(value: T): T => _stripEffects(value) as T;

const _stripEffects = (value: unknown): unknown => {
  if (value == null || isPrimitive(value)) return value;
  // Output proxies are left intact (so `isResolved` still sees them); they
  // must be tested BEFORE `Effect.isEffect` because Output exprs are
  // yieldable and would otherwise be misclassified as plain Effects.
  if (Output.isExpr(value)) return value;
  if (Effect.isEffect(value)) return undefined;
  if (Redacted.isRedacted(value) || Duration.isDuration(value)) return value;
  if (Array.isArray(value)) return value.map(_stripEffects);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, _stripEffects(item)]),
    );
  }
  return value;
};

export const somePropsAreDifferent = <Props extends Record<string, any>>(
  olds: Props,
  news: Props,
  props: (keyof Props)[],
) => {
  for (const prop of props) {
    if (olds[prop] !== news[prop]) {
      return true;
    }
  }
  return false;
};

export const anyPropsAreDifferent = <Props extends Record<string, any>>(
  olds: Props,
  news: Props,
) => {
  for (const prop in olds) {
    if (olds[prop] !== news[prop]) {
      return true;
    }
  }
  for (const prop in news) {
    if (!(prop in olds)) {
      return true;
    }
  }
  return false;
};

export const havePropsChanged = <Props extends object>(
  oldProps: Props | undefined,
  newProps: Props,
) =>
  Output.hasOutputs(newProps) ||
  // Compare both sides through `stripUnresolved` so the comparison is
  // symmetric with the commit boundary: persisted props can never hold an
  // Effect or Output expr (stripped at commit / silently dropped by JSON
  // serialization), while desired props may still carry them — e.g. a tagged
  // Worker class in `env` serializes via its `toJSON` to
  // `{"_id":"Effect",...}` and would otherwise report a phantom change on
  // every plan, forever (#874). Unresolved Outputs in `newProps` are already
  // caught by the `hasOutputs` guard above, so stripping here never hides a
  // real difference.
  JSON.stringify(canonicalize(stripUnresolved(oldProps ?? {}), false)) !==
    JSON.stringify(canonicalize(stripUnresolved(newProps ?? {}), false));

export type DeepEqualOptions = {
  /**
   * When true, treat `null` and `undefined` as equivalent at any depth.
   * Useful when comparing cloud-API responses (which often return `null`
   * for unconfigured optional fields) against desired-state shapes built
   * from `props?.x` (which leave the same fields `undefined`).
   *
   * @default false
   */
  stripNullish?: boolean;
};

/**
 * Sort-keys deep equality for plain data (objects, arrays, primitives).
 * Use in provider `diff` handlers instead of ad-hoc `JSON.stringify` comparisons.
 *
 * By default, `null` and `undefined` are treated as distinct. Pass
 * `{ stripNullish: true }` to opt into treating them as equivalent.
 */
export const deepEqual = (
  a: unknown,
  b: unknown,
  options?: DeepEqualOptions,
): boolean =>
  JSON.stringify(canonicalize(a, options?.stripNullish ?? false)) ===
  JSON.stringify(canonicalize(b, options?.stripNullish ?? false));

const canonicalize = (value: unknown, stripNullish: boolean): unknown => {
  if (stripNullish && value == null) return undefined;
  if (Redacted.isRedacted(value)) {
    return {
      _tag: "Redacted",
      value: Redacted.value(value),
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v, stripNullish));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => !stripNullish || nested != null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested, stripNullish)]),
    );
  }
  return value;
};

/**
 * Deterministic ordering for binding rows.
 *
 * Bindings are registered by concurrently-built layers (a Function/Worker's
 * capability layers run real IO — bundling, fs — before calling `host.bind`),
 * so the registration order of `stack.bindings[fqn]` is not stable across
 * deploys. `diffBindings` itself is sid-keyed and order-insensitive, but the
 * row order flows into provider `diff`/`reconcile` inputs and persisted
 * state — any consumer that hashes or deep-compares the binding array (e.g.
 * a metadata hash over bindings) would churn on registration-order flips.
 * Sorting by `sid` at every boundary makes binding rows stable.
 */
const bySid = (a: { sid: string }, b: { sid: string }): number =>
  a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0;

export const sortBindings = <B extends { sid: string }>(bindings: B[]): B[] =>
  [...bindings].sort(bySid);

/**
 * Collapse bindings that share the same `sid`, keeping the last occurrence,
 * and return them in deterministic (sid-sorted) order.
 *
 * The same binding can be recorded more than once on a target resource — e.g.
 * a KV namespace bound to both a Worker and a Workflow ends up pushed twice to
 * `stack.bindings[fqn]`. `diffBindings` already collapses these implicitly via
 * its `Map` keyed by `sid`, so the `reconcile` path never observes duplicates.
 * Use this helper to give a provider's `diff` handler the same de-duplicated
 * binding set, keeping plan-time hashing consistent with deploy-time.
 */
export const dedupeBindings = <B extends ResourceBinding>(bindings: B[]): B[] =>
  sortBindings(Array.from(new Map(bindings.map((b) => [b.sid, b])).values()));

export const diffBindings = (
  oldBindings: ResourceBinding[],
  newBindings: ResourceBinding[],
): BindingNode[] => {
  const oldMap = new Map(oldBindings.map((b) => [b.sid, b]));
  const newMap = new Map(newBindings.map((b) => [b.sid, b]));
  return sortBindings([
    ...Array.from(oldMap)
      .filter(([sid]) => !newMap.has(sid))
      .map(([sid, old]) => ({
        sid,
        action: "delete" as const,
        data: old.data,
      })),
    ...Array.from(newMap).map(([sid, binding]) => {
      const old = oldMap.get(sid);
      return {
        sid,
        action: (!old
          ? "create"
          : havePropsChanged(old.data, binding.data)
            ? "update"
            : "noop") as BindingNode["action"],
        data: binding.data,
      };
    }),
  ]);
};
