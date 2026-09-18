/** Hosts differ on the case and padding they hand back, and a handle is neither. */
export function normalizeLogin(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
