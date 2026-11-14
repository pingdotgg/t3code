/**
 * Provider instances that just failed an Auto thread with a usage limit or no capacity. The
 * usage report can lag behind (or never show a gateway's 429), so Auto routing skips these until
 * the cooldown ends. Lives in memory: a server restart forgets it, and the usage report takes over.
 */
const cooldowns = new Map<string, number>();

/** Per instance; a model-scoped limit (Antigravity pools) still benches the whole instance. */
export function markAutoCooldown(instanceId: string, untilMs: number): void {
  const current = cooldowns.get(instanceId) ?? 0;
  if (untilMs > current) cooldowns.set(instanceId, untilMs);
}

export function isAutoCoolingDown(instanceId: string, nowMs: number): boolean {
  const until = cooldowns.get(instanceId);
  if (until === undefined) return false;
  if (until > nowMs) return true;
  cooldowns.delete(instanceId);
  return false;
}

/** Tests only. */
export function clearAutoCooldowns(): void {
  cooldowns.clear();
}
