const niceStep = (span: number) => {
  const raw = span / 8;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  return (scaled < 1.5 ? 1 : scaled < 3.5 ? 2 : scaled < 7.5 ? 5 : 10) * magnitude;
};

/** Round values to draw grid lines at. Counts lines: a large value plus a small step is itself. */
export const gridLines = (from: number, to: number): ReadonlyArray<number> => {
  const step = niceStep(to - from);
  const first = Math.ceil(from / step);
  const count = Math.floor(to / step) - first + 1;
  // Not finite or not positive: the range is empty or beyond what numbers can span.
  if (!(count > 0 && Number.isFinite(count))) return [];
  return Array.from({ length: count }, (_, at) => Number(((first + at) * step).toPrecision(12)));
};
