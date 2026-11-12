/**
 * Annotation keys alchemy reads. `fqn` is an ordinary attribute (the
 * resource a record is about, when there is one); the rest map onto
 * envelope fields instead of `attributes`.
 */
export const LogAnnotation = {
  fqn: "fqn",
  stream: "alchemy.stream",
  process: "alchemy.process",
  /** Set by `emit`: the record's message is a typed event. */
  event: "alchemy.event",
  /** `"global"`: account-level work, filed in the global run log. */
  scope: "alchemy.scope",
  /** Set on replay: what the original record carried. */
  time: "alchemy.time",
  cause: "alchemy.cause",
  trace: "alchemy.trace",
} as const;
