const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatScheduledTaskInterval(everyMs: number): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    // Keep mixed intervals in hours instead of splitting them into days or weeks.
    if (size >= DAY && everyMs % size !== 0) continue;
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && size === everyMs) return `Every ${unit}`;
    parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    remaining %= size;
  }
  const duration =
    parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Every ${duration}`;
}
