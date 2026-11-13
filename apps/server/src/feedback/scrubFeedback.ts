const FEEDBACK_TEXT_MAX_CHARS = 300;

const REDACTED = "[redacted]";

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const TOKEN_PREFIX =
  /\b(?:sk-|sk_live_|pk_live_|rk_live_|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|xapp-|npm_|hf_|AIza|AKIA|ASIA)[A-Za-z0-9_-]{8,}/gu;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@\S+/giu;
const EMAIL = /[A-Za-z0-9.!#$%&'*+=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
// Slashes are left out so ordinary paths stay readable.
const LONG_RUN = /[A-Za-z0-9_+=-]{32,}/gu;

const entropy = (value: string) => {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
};

// Long identifiers such as tool names have few digits; keys, hashes and ids have many.
const looksRandom = (value: string) =>
  (value.match(/\d/gu)?.length ?? 0) >= 2 && /[A-Za-z]/u.test(value) && entropy(value) >= 3.5;

/**
 * Removes values the server knows are private to this caller, then anything
 * shaped like a secret, email address, or URL with credentials, and caps the
 * result at FEEDBACK_TEXT_MAX_CHARS characters.
 */
export function scrubFeedback(text: string, sensitive: ReadonlyArray<string>): string {
  let scrubbed = text;
  // Longest first, so a path is replaced whole before the username inside it.
  const known = [...new Set(sensitive.map((value) => value.trim()))]
    .filter((value) => value.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const value of known) {
    scrubbed = scrubbed.replaceAll(
      new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(value)}(?![A-Za-z0-9_])`, "gu"),
      REDACTED,
    );
  }
  scrubbed = scrubbed
    .replaceAll(CREDENTIAL_URL, REDACTED)
    .replaceAll(TOKEN_PREFIX, REDACTED)
    .replaceAll(JWT, REDACTED)
    .replaceAll(EMAIL, REDACTED)
    .replaceAll(LONG_RUN, (value) => (looksRandom(value) ? REDACTED : value));
  return Array.from(scrubbed).slice(0, FEEDBACK_TEXT_MAX_CHARS).join("");
}
