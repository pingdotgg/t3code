export type EnvRecord = Readonly<Record<string, string | undefined>>;

export function isManagedRuntimeEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized.startsWith("T3CODE_") || normalized.startsWith("T3_");
}

export function stripManagedRuntimeEnvKeys(env: EnvRecord | undefined): Record<string, string> {
  const next: Record<string, string> = {};
  if (!env) return next;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isManagedRuntimeEnvKey(key)) continue;
    next[key] = value;
  }
  return next;
}
