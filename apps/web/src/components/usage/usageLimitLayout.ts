import type { LimitPoolWindow } from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";

export const USAGE_LIMIT_LAYOUT_KEY = "t3code:usage-limit-layout:v1";
export const UsageLimitLayoutSchema = Schema.Struct({
  providerOrder: Schema.Array(Schema.String),
  windowOrder: Schema.Array(Schema.String),
  hiddenWindows: Schema.Array(Schema.String),
});
export type UsageLimitLayout = typeof UsageLimitLayoutSchema.Type;
export const DEFAULT_LIMIT_LAYOUT: UsageLimitLayout = {
  providerOrder: [],
  windowOrder: [],
  hiddenWindows: [],
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
  direction: -1 | 1,
) {
  const keys = [...currentKeys];
  const index = keys.indexOf(key);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= keys.length) return savedOrder;
  [keys[index], keys[destination]] = [keys[destination]!, keys[index]!];
  const available = new Set(keys);
  return [...keys, ...savedOrder.filter((id) => !available.has(id))];
}
