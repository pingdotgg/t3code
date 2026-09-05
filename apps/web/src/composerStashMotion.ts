/** Traces a small teardrop into the stash tab, at constant speed along each curve. */
export function composerStashKeyframes(x: number, y: number) {
  const bow = 16;
  const dip = 6;
  const segments = [
    [
      [0, 0],
      [0, dip * 0.68],
      [bow * 0.18, dip],
      [bow * 0.48, dip],
    ],
    [
      [bow * 0.48, dip],
      [bow * 0.82, dip],
      [bow, y * 0.08],
      [bow, y * 0.22],
    ],
    [
      [bow, y * 0.22],
      [bow, y * 0.58],
      [bow * 0.16, y * 0.96],
      [0, y],
    ],
  ] as const;
  let previous = { x: 0, y: 0, distance: 0 };
  const points = [previous];
  for (const [p0, p1, p2, p3] of segments) {
    for (let step = 1; step <= 80; step++) {
      const t = step / 80;
      const u = 1 - t;
      const px = u ** 3 * p0[0] + 3 * u ** 2 * t * p1[0] + 3 * u * t ** 2 * p2[0] + t ** 3 * p3[0];
      const py = u ** 3 * p0[1] + 3 * u ** 2 * t * p1[1] + 3 * u * t ** 2 * p2[1] + t ** 3 * p3[1];
      previous = {
        x: px,
        y: py,
        distance: previous.distance + Math.hypot(px - previous.x, py - previous.y),
      };
      points.push(previous);
    }
  }
  // Distance-based offsets keep velocity continuous where the curve segments join.
  return points.map((point) => {
    const offset = point.distance / previous.distance;
    return { transform: `translate(${point.x + x * offset}px, ${point.y}px) scale(1)`, offset };
  });
}
