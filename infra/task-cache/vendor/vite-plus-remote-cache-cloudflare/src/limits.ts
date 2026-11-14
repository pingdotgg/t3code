export const MiB = 1024 * 1024;
export const PART_SIZE = 5 * MiB;
export const LEASE_SECONDS = 15 * 60;
export const GRACE_SECONDS = 10 * 60;

export const defaults = {
  key: 16 * 1024,
  value: 4 * MiB,
  metadata: 5 * MiB,
  fetch: 40 * 1024,
  blob: 64 * MiB,
  store: 72 * MiB,
  headers: 8 * 1024,
  deadlineMs: 120_000,
};
export type Limits = typeof defaults;

export function limitsFrom(raw: string): Limits {
  const input: unknown = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid limits');
  const result = { ...defaults };
  for (const [name, value] of Object.entries(input)) {
    if (
      !(name in defaults) ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > defaults[name as keyof Limits]
    ) {
      throw new Error('Limits must be positive integers no larger than the tested defaults');
    }
    result[name as keyof Limits] = value;
  }
  if (
    result.metadata < 2 * result.key + result.value + 128 ||
    result.fetch < 2 * result.key + 128 ||
    result.store < result.metadata + result.blob + 1024
  ) {
    throw new Error('Envelope limits must accommodate field limits and framing');
  }
  return result;
}
