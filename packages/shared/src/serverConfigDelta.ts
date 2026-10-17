import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";

type ConfigDelta = Extract<ServerConfigStreamEvent, { readonly type: "configDelta" }>;

function changedFields<T extends object>(previous: T, next: T) {
  const changes: Partial<T> = {};
  const removed: string[] = [];
  for (const key of Object.keys(next) as Array<keyof T & string>) {
    if (next[key] === undefined) continue;
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = next[key];
  }
  // JSON drops a field set to undefined, as the config hash does, so it is a removal.
  for (const key of Object.keys(previous) as Array<keyof T & string>) {
    if (previous[key] !== undefined && next[key] === undefined) removed.push(key);
  }
  return { changes, removed };
}

/** Provider catalogs stay on the client when only health or quota changes. */
export function diffServerConfig(
  previous: ServerConfig,
  next: ServerConfig,
  configVersion: string,
): ConfigDelta {
  const { providers: _previous, ...previousFields } = previous;
  const { providers: _next, ...nextFields } = next;
  const fields = changedFields(previousFields, nextFields);
  const previousProviders = new Map(
    previous.providers.map((provider) => [provider.instanceId, provider]),
  );
  const providerChanges = next.providers.flatMap((provider) => {
    const current = previousProviders.get(provider.instanceId);
    const patch =
      current === undefined ? { changes: provider, removed: [] } : changedFields(current, provider);
    return Object.keys(patch.changes).length === 0 && patch.removed.length === 0
      ? []
      : [{ instanceId: provider.instanceId, ...patch }];
  });
  const providerOrder = next.providers.map((provider) => provider.instanceId);
  return {
    version: 1,
    type: "configDelta",
    configVersion,
    ...fields,
    providerChanges,
    ...(JSON.stringify(previous.providers.map((provider) => provider.instanceId)) ===
    JSON.stringify(providerOrder)
      ? {}
      : { providerOrder }),
  };
}
