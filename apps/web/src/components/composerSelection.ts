export type ComposerSelectionRange = {
  start: number;
  end: number;
};

export function didComposerSelectionChangeVisibly(
  previous: ComposerSelectionRange,
  next: ComposerSelectionRange | null,
): boolean {
  return (
    next !== null &&
    next.start !== next.end &&
    (next.start !== previous.start || next.end !== previous.end)
  );
}
