export function trimmedUnknownString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}
