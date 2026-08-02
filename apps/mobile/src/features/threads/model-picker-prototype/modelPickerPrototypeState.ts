export type GesturePoint = {
  readonly x: number;
  readonly y: number;
};

export function takeUniquePaletteIds(
  ids: readonly string[],
  maximumChoices: number,
): ReadonlySet<string> {
  return new Set([...new Set(ids)].slice(0, maximumChoices));
}

export function hasDeliberateGestureTravel(
  start: GesturePoint | null,
  current: GesturePoint,
  minimumTravel: number,
): boolean {
  if (!start) return false;
  return Math.hypot(current.x - start.x, current.y - start.y) >= minimumTravel;
}
