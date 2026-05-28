const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T(?<hours>\d{2}):(?<minutes>\d{2}):/;

export function formatAgentActivityUpdatedAtLabel(updatedAt: string): string {
  const match = ISO_TIME_PATTERN.exec(updatedAt);
  const hours24 = Number(match?.groups?.hours);
  const minutes = match?.groups?.minutes;
  if (!Number.isInteger(hours24) || hours24 < 0 || hours24 > 23 || !minutes) {
    return "now";
  }

  return `${hours24 % 12 || 12}:${minutes}`;
}
