export function nextCycleIndex(
  currentIndex: number,
  length: number,
  direction: "next" | "previous",
): number | null {
  if (length <= 1) return null;
  const startIndex = currentIndex < 0 || currentIndex >= length ? 0 : currentIndex;
  const offset = direction === "next" ? 1 : -1;
  return (startIndex + offset + length) % length;
}

export function nextDirectionalIndex(
  currentIndex: number,
  length: number,
  direction: "left" | "right",
): number | null {
  if (currentIndex < 0 || currentIndex >= length) return null;
  const offset = direction === "right" ? 1 : -1;
  const nextIndex = currentIndex + offset;
  if (nextIndex < 0 || nextIndex >= length) return null;
  return nextIndex;
}
