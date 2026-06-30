/**
 * Redacts sensitive strings (tokens, secrets, high-entropy values) from text,
 * and provides a tail-keeping truncation utility.
 *
 * Pure module — no Effect, no external dependencies.
 */

/**
 * Pattern that tests whether a variable name contains a sensitive word as a
 * complete underscore-delimited segment (e.g. MY_TOKEN, API_KEY, access_token)
 * but NOT as an arbitrary substring (e.g. KEYBOARD is not sensitive).
 */
const SENSITIVE_NAME = /(?:^|_)(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)(?:_|$)/i;

/**
 * Build each regex fresh per call so we never have lastIndex statefulness
 * issues from module-level shared regexes used with repeated replacements.
 *
 * Order matters: specific token patterns run before the NAME=value sweep so
 * that tokens embedded in `name: <token>` lines are redacted by the token
 * pattern first, leaving `name: [redacted]`. The NAME=value pattern then uses
 * a negative lookahead to skip lines whose value is already `[redacted]`.
 */
const buildPatterns = (): Array<(text: string) => string> => [
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_
  (t) => t.replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted]"),
  // GitHub fine-grained PATs
  (t) => t.replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"),
  // OpenAI API keys
  (t) => t.replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]"),
  // Stripe-style secret / restricted keys (sk_live_, sk_test_, rk_live_,
  // rk_test_). These are all-lowercase+digit after the prefix, so the OpenAI
  // `sk-` rule (hyphen) and the uppercase-requiring high-entropy sweep both
  // miss them; match the explicit prefix instead.
  (t) => t.replace(/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[redacted]"),
  // Bearer tokens (HTTP Authorization header values, ≥16 chars)
  (t) => t.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, "[redacted]"),
  // AWS access key IDs (AKIA + exactly 16 uppercase alnum chars)
  (t) => t.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"),
  // NAME=value or NAME: value lines where NAME contains a sensitive word as a
  // complete _ segment.  Only fires when the value is NOT already `[redacted]`
  // (prevents double-processing lines already handled by a specific pattern).
  (t) =>
    t.replace(/^([A-Za-z_]+)\s*[=:]\s*(?!\[redacted\])(\S+)$/gim, (_, name: string) =>
      SENSITIVE_NAME.test(name) ? `${name}=[redacted]` : _,
    ),
];

/**
 * High-entropy string pattern: ≥32 non-whitespace chars that contain at least
 * one uppercase letter, one lowercase letter, and one digit.
 * Applied last — already-replaced `[redacted]` markers are 10 chars and won't
 * match, so there's no risk of double-processing.
 *
 * Known limitation (over-redaction): this also catches benign mixed-case
 * ≥32-char tokens that commonly appear in CI logs — e.g. npm SRI integrity
 * hashes (`sha512-...`), JWTs, and git/content hashes. These are reproducible
 * and non-damaging, so over-redacting them is acceptable.
 *
 * Known limitation (under-redaction): the uppercase+lowercase+digit gate is
 * DELIBERATE — it avoids redacting all-lowercase-hex git SHAs and similar IDs.
 * The cost is that a purely-lowercase-hex secret (32+ hex chars, no uppercase)
 * is NOT swept here. Prefixed secrets are covered by the explicit patterns above
 * (gh*_, github_pat_, sk-/[rs]k_(live|test)_, Bearer, AKIA); a generic
 * lowercase-hex sweep is intentionally omitted to keep the git-SHA false-positive
 * rate low. Add a contextual pattern above if a specific lowercase-only secret
 * format needs coverage.
 */
const HIGH_ENTROPY_RE = /\b(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[A-Za-z0-9+/_=-]{32,}\b/g;

/**
 * Redacts known credential patterns and high-entropy strings from `text`.
 * Returns the sanitised copy; the original is not mutated.
 */
export const redactSensitiveText = (text: string): string => {
  let out = text;
  for (const apply of buildPatterns()) out = apply(out);
  // High-entropy sweep runs after all known patterns.
  out = out.replace(HIGH_ENTROPY_RE, "[redacted]");
  return out;
};

const TRUNCATION_MARKER = "…[truncated]\n";

/**
 * If `text` is longer than `max` characters, returns a string of length ≤ `max`
 * that starts with the marker line "…[truncated]\n" followed by the LAST chars
 * of `text`. The marker is INCLUDED in the budget, so the result never exceeds
 * `max` — callers can pass a hard limit (e.g. the ticket message body cap) and
 * rely on the output fitting under it. Otherwise returns `text` unchanged.
 *
 * When `max` is smaller than the marker itself, the marker is truncated to fit
 * (degenerate but bounded) so the contract — result length ≤ max — always holds.
 */
export const truncateKeepingTail = (text: string, max: number): string => {
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, Math.max(0, max));
  }
  const tailBudget = max - TRUNCATION_MARKER.length;
  return `${TRUNCATION_MARKER}${text.slice(text.length - tailBudget)}`;
};

const HEAD_TRUNCATION_MARKER = "…[truncated]";

/**
 * If `text` is longer than `max`, returns a string of length ≤ `max` that keeps
 * the START of `text` followed by the "…[truncated]" marker. The marker is
 * INCLUDED in the budget so the result never exceeds `max`. Otherwise returns
 * `text` unchanged.
 *
 * Use this (not `truncateKeepingTail`) where the meaningful content is at the
 * front — e.g. a one-line push-notification preview of an attention reason,
 * whose actionable summary leads and whose trailing noise (logs/stack frames)
 * is the part safe to drop.
 *
 * When `max` is smaller than the marker itself, the marker is truncated to fit
 * (degenerate but bounded) so the contract — result length ≤ max — always holds.
 */
export const truncateKeepingHead = (text: string, max: number): string => {
  if (text.length <= max) return text;
  if (max <= HEAD_TRUNCATION_MARKER.length) {
    return HEAD_TRUNCATION_MARKER.slice(0, Math.max(0, max));
  }
  const headBudget = max - HEAD_TRUNCATION_MARKER.length;
  return `${text.slice(0, headBudget)}${HEAD_TRUNCATION_MARKER}`;
};
