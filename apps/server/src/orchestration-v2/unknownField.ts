/** Readers for decoding undeclared provider payloads without trusting shapes. */
export function field(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null ? Reflect.get(source, key) : undefined;
}

export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
