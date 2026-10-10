/**
 * Shared name-mangling helpers for Prisma physical names and binding env
 * keys. Internal — not exported from the Prisma package surface.
 */

export const fnv1a64 = (value: string) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0").toUpperCase();
};

/**
 * Deterministic physical name for a cloud object owned by one resource
 * instance: the logical name plus a 12-character token of the instance
 * identity, inside a 65-character budget. Stable across retries, so a create
 * whose response was lost (crash after the POST but before the state persist)
 * can be recovered by name instead of minting a second object.
 */
export const physicalInstanceName = (name: string, instanceId: string) => {
  const instanceToken = instanceId.replaceAll(/[^a-zA-Z0-9]/g, "");
  const effectiveSuffix =
    instanceToken.length >= 12
      ? instanceToken.slice(0, 12)
      : fnv1a64(instanceId).slice(0, 12);
  const maxPrefixLength = 65 - effectiveSuffix.length - 1;
  return `${name.trim().slice(0, maxPrefixLength)}-${effectiveSuffix}`;
};

export const envName = (value: string) => {
  const normalized = value.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  // Preserve the established keys for conventional PascalCase FQNs while
  // disambiguating arbitrary logical IDs whose lossy normalization can
  // collide (`db-a`, `db_a`, and `db.a`, for example).
  const canonical = value
    .split("/")
    .every((segment) => /^[A-Z][a-z0-9]*$/.test(segment));
  return canonical ? normalized : `${normalized}_${fnv1a64(value)}`;
};
