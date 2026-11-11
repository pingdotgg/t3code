export interface ProgressProps {
  /** Omit for indeterminate progress. Finite values are clamped to 0..1. */
  readonly value?: number;
  readonly label?: string;
  readonly className?: string;
}

export function clampProgress(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.min(1, value));
}
