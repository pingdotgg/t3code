/**
 * "Observed satisfies desired" predicate for Google API structs: every key in
 * `desired` must match the same key in `observed`; keys the caller did not
 * specify are ignored. A desired proto3 default (`false`, `0`, `""`, `[]`)
 * matches an observed key the API omitted, because the JSON encoding of a
 * proto3 message drops default-valued fields.
 *
 * Use in reconcilers to decide whether an update call is needed for a
 * partial config the user supplied (GKE addons, Shielded VM settings, …). *
 * NOT exported from `index.ts`.
 */
export const matchesDesired = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    if (observed == null) return desired.length === 0;
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((value, index) => matchesDesired(observed[index], value))
    );
  }
  if (desired === null || typeof desired !== "object") {
    if (desired === null) return observed === null;
    if (observed == null) {
      return desired === false || desired === 0 || desired === "";
    }
    return observed === desired;
  }
  if (observed == null) {
    return Object.values(desired).every((value) => matchesDesired(undefined, value));
  }
  if (typeof observed !== "object") return false;
  return Object.entries(desired).every(([key, value]) =>
    matchesDesired((observed as Record<string, unknown>)[key], value),
  );
};
