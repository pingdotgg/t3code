import * as Effect from "effect/Effect";
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
  JSON.stringify(canonicalize(oldProps ?? {}, false)) !==
    JSON.stringify(canonicalize(newProps ?? {}, false));

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
 * Collapse bindings that share the same `sid`, keeping the last occurrence.
 *
 * The same binding can be recorded more than once on a target resource — e.g.
 * a KV namespace bound to both a Worker and a Workflow ends up pushed twice to
 * `stack.bindings[fqn]`. `diffBindings` already collapses these implicitly via
 * its `Map` keyed by `sid`, so the `reconcile` path never observes duplicates.
 * Use this helper to give a provider's `diff` handler the same de-duplicated
 * binding set, keeping plan-time hashing consistent with deploy-time.
 */
export const dedupeBindings = <B extends ResourceBinding>(bindings: B[]): B[] =>
  Array.from(new Map(bindings.map((b) => [b.sid, b])).values());

export const diffBindings = (
  oldBindings: ResourceBinding[],
  newBindings: ResourceBinding[],
): BindingNode[] => {
  const oldMap = new Map(oldBindings.map((b) => [b.sid, b]));
  const newMap = new Map(newBindings.map((b) => [b.sid, b]));
  return [
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
  ];
};
