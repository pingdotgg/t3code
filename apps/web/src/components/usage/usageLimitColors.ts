export function usageLimitBarColor(providerColor: string, remainingPercent: number): string {
  return remainingPercent <= 10
    ? "var(--destructive)"
    : remainingPercent <= 30
      ? "var(--warning)"
      : providerColor;
}
