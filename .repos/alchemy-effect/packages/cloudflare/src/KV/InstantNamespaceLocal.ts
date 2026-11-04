// Carry Instant mode in the persisted local identity so Worker bindings and
// per-operation platform proxies select the same simulator behavior after reload.
const prefix = "dev:kv-instant:";

export const createInstantNamespaceLocalId = () => `${prefix}${crypto.randomUUID()}`;
export const isInstantNamespaceLocalId = (id: string) => id.startsWith(prefix);
