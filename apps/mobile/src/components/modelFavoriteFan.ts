import type { ModelFavorites } from "@t3tools/contracts";
import type { ModelOption } from "../lib/modelOptions";

export const FAVORITE_FAN_LIMIT = 5;
export const FAVORITE_FAN_TARGET_SIZE = 52;

export function resolveFanModels(
  favorites: typeof ModelFavorites.Type,
  models: ReadonlyArray<ModelOption>,
): ReadonlyArray<ModelOption> {
  if (favorites.length === 0) return [];
  const byKey = new Map(models.map((model) => [model.key, model]));
  const available = new Map<string, ModelOption>();
  for (const favorite of favorites) {
    const model = byKey.get(`${favorite.provider}:${favorite.model}`);
    if (model && !model.isUnavailable && !model.isHidden) {
      available.set(model.key, model);
      if (available.size === FAVORITE_FAN_LIMIT) break;
    }
  }
  return [...available.values()];
}

type Point = { readonly x: number; readonly y: number };
type FanBounds = { readonly left: number; readonly right: number; readonly top: number };

export function layoutFavoriteFan(origin: Point, bounds: FanBounds, count: number) {
  const margin = FAVORITE_FAN_TARGET_SIZE / 2 + 10;
  const radius = Math.min(108, (bounds.right - bounds.left) / 2 - margin);
  const spread = ((count - 1) * Math.PI) / 5.5;
  const halfSpan = Math.sin(spread / 2) * radius + margin;
  const centerX = Math.min(Math.max(origin.x, bounds.left + halfSpan), bounds.right - halfSpan);
  const centerY = Math.max(origin.y, bounds.top + radius + margin + 50);

  const targets = Array.from({ length: count }, (_, index) => {
    const angle = count === 1 ? 0 : (index / (count - 1) - 0.5) * spread;
    return {
      x: centerX + Math.sin(angle) * radius,
      y: centerY - Math.cos(angle) * radius,
    };
  });

  const labelWidth = Math.min(216, bounds.right - bounds.left - 20);
  const labelLeft = Math.min(
    Math.max(centerX - labelWidth / 2, bounds.left + 10),
    bounds.right - labelWidth - 10,
  );
  return { targets, labelLeft, labelWidth, labelBottom: centerY - radius - margin };
}

export function hitFavoriteFan(targets: readonly Point[], origin: Point, x: number, y: number) {
  "worklet";
  // Keep the initial press and a return to the button safe to release.
  if ((x - origin.x) ** 2 + (y - origin.y) ** 2 < 28 ** 2) return -1;
  let closestDistance = (FAVORITE_FAN_TARGET_SIZE / 2 + 5) ** 2;
  let closest = -1;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const distance = (x - target.x) ** 2 + (y - target.y) ** 2;
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = index;
    }
  }
  return closest;
}
