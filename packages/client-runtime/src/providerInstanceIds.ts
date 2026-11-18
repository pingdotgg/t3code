/** Limit the slug to 48 chars so the composed ProviderInstanceId fits its 64-char cap. */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export function deriveInstanceId(driver: string, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

export function deriveAvailableInstanceId(
  derive: (label: string) => string,
  label: string,
  existing: ReadonlySet<string>,
): string {
  const base = derive(label);
  if (!base || !existing.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    if (!existing.has(candidate)) return candidate;
  }
}
