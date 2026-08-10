import * as Schema from "effect/Schema";

/**
 * Provider failures for which a user can reasonably continue the same
 * submission from a fresh thread with a different model or account.
 *
 * This is deliberately small and opt-in: unclassified failures must not
 * surface a recovery affordance that suggests switching threads will help.
 */
export const RecoverableThreadFailureKind = Schema.Literals([
  "authentication",
  "model_unavailable",
]);
export type RecoverableThreadFailureKind = typeof RecoverableThreadFailureKind.Type;
