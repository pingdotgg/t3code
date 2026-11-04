/**
 * Helpers for the observed-attribute projections `read` and `reconcile`
 * share, so `alchemy drift` compares like with like.
 */

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortKeysDeep(nested)]),
    );
  }
  return value;
};

/**
 * A JSON document (string or object) in canonical form: keys sorted at every
 * depth, no whitespace. AWS often reorders or re-spaces documents it stores
 * (policies, event patterns, state machine definitions), so drift compares
 * this form. Strings that do not parse are returned unchanged.
 */
export const canonicalJson = (document: string | object | undefined): string | undefined => {
  if (document === undefined) return undefined;
  if (typeof document !== "string") return JSON.stringify(sortKeysDeep(document));
  try {
    return JSON.stringify(sortKeysDeep(JSON.parse(document)));
  } catch {
    return document;
  }
};

/**
 * A value made safe to persist and compare as plain JSON: byte arrays
 * become base64 strings, `null` becomes `undefined`, and the keys of every
 * object are sorted. Use it on SDK response structures stored in observed
 * attributes.
 */
export const plainJson = <T>(value: T): T => toPlain(value) as T;

const toPlain = (value: unknown): unknown => {
  if (value === null) return undefined;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === "object" && value !== undefined) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined && nested !== null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, toPlain(nested)]),
    );
  }
  return value;
};

/**
 * A tag list whose `Key`/`Value` are optional on the wire (EC2, ELBv2, …)
 * as a record. Entries without a key are dropped.
 */
export const tagListRecord = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? []).flatMap((tag) => (tag.Key === undefined ? [] : [[tag.Key, tag.Value ?? ""]])),
  );
