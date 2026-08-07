export function parseRequiredNumber(value: string, label: string): number {
  if (value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return Number(value);
}
