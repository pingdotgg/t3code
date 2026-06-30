/**
 * Bound an inbound webhook payload before it enters predicates and the
 * route-decision snapshot: JSON-aware (never truncated JSON strings), depth
 * and breadth capped, long strings clipped.
 */
const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ARRAY = 100;
const MAX_STRING = 2_000;

export const sanitizeExternalEventPayload = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  }
  if (depth >= MAX_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY)
      .map((entry) => sanitizeExternalEventPayload(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let keys = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (keys >= MAX_KEYS) {
        break;
      }
      // "__proto__" as an own key would mutate the prototype on assignment,
      // letting predicates see values absent from the persisted snapshot.
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        continue;
      }
      const sanitized = sanitizeExternalEventPayload(entry, depth + 1);
      if (sanitized !== undefined) {
        out[key.slice(0, MAX_STRING)] = sanitized;
        keys += 1;
      }
    }
    return out;
  }
  // Functions, symbols, undefined — not representable.
  return undefined;
};
