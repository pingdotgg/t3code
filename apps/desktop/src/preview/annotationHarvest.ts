export interface HarvestRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HarvestBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly childCount: number;
  readonly isControl: boolean;
}

/** Cap so a full-page box does not dump every leaf node into the payload. */
export const MAX_HARVEST_TARGETS = 20;

export function isCenterInRect(box: HarvestBox, rect: HarvestRect): boolean {
  if (box.width < 2 || box.height < 2) return false;
  const midX = box.left + box.width / 2;
  const midY = box.top + box.height / 2;
  return (
    midX >= rect.x && midX <= rect.x + rect.width && midY >= rect.y && midY <= rect.y + rect.height
  );
}

export function isHarvestTarget(box: HarvestBox): boolean {
  return box.childCount === 0 || box.isControl;
}

export function harvestBoxes<T extends HarvestBox>(
  items: ReadonlyArray<T>,
  rect: HarvestRect,
  limit = MAX_HARVEST_TARGETS,
): T[] {
  return items
    .filter((item) => isCenterInRect(item, rect) && isHarvestTarget(item))
    .sort((left, right) => left.width * left.height - right.width * right.height)
    .slice(0, limit);
}

export function summarizeHarvestLabels(
  labels: ReadonlyArray<string>,
  fallback = "This area",
): string {
  const cleaned = labels.map((label) => label.trim()).filter((label) => label.length > 0);
  if (cleaned.length === 0) return fallback;
  if (cleaned.length <= 3) return cleaned.join(" · ");
  return `${cleaned.slice(0, 3).join(" · ")} +${cleaned.length - 3}`;
}
