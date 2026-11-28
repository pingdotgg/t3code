export type ProgressProps = {
  readonly label?: string;
  readonly className?: string;
} & (
  | { readonly value?: number; readonly percent?: never }
  | { readonly value?: never; readonly percent?: number }
);

/** Accept a fraction or a display percentage. Omit both for indeterminate progress. */
export function resolveProgress({ value, percent }: ProgressProps) {
  if (percent !== undefined && Number.isFinite(percent)) {
    const now = Math.max(0, Math.min(100, percent));
    return { fraction: now / 100, now };
  }
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const fraction = Math.max(0, Math.min(1, value));
  return { fraction, now: Math.floor(fraction * 100) };
}
