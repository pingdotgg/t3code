import type { LimitPoolWindow } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const USAGE_LIMIT_LAYOUT_KEY = "t3code:usage-limit-layout:v1";
export const UsageLimitLayoutSchema = Schema.Struct({
  providerOrder: Schema.Array(Schema.String),
  windowOrder: Schema.Array(Schema.String),
  hiddenWindows: Schema.Array(Schema.String),
  hiddenProviders: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  collapsedProviders: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type UsageLimitLayout = typeof UsageLimitLayoutSchema.Type;
export const DEFAULT_LIMIT_LAYOUT: UsageLimitLayout = {
  providerOrder: [],
  windowOrder: [],
  hiddenWindows: [],
  hiddenProviders: [],
  collapsedProviders: [],
};

export function limitWindowKey(driver: string, window: Pick<LimitPoolWindow, "kind" | "id">) {
  return JSON.stringify([driver, window.kind, window.id]);
}

export function orderLimitItems<T>(
  items: readonly T[],
  order: readonly string[],
  key: (item: T) => string,
): T[] {
  const ranks = new Map(order.map((id, index) => [id, index]));
  return [...items].sort(
    (left, right) => (ranks.get(key(left)) ?? Infinity) - (ranks.get(key(right)) ?? Infinity),
  );
}

export function moveLimitItem(
  savedOrder: readonly string[],
  currentKeys: readonly string[],
  key: string,
  over: string,
) {
  const keys = [...currentKeys];
  const index = keys.indexOf(key);
  const destination = keys.indexOf(over);
  if (index < 0 || destination < 0 || index === destination) return savedOrder;
  keys.splice(index, 1);
  keys.splice(destination, 0, key);
  const available = new Set(keys);
  return [...keys, ...savedOrder.filter((id) => !available.has(id))];
}
