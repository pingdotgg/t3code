const FEEDBACK_TEXT_MAX_CHARS = 300;

const REDACTED = "[redacted]";

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const TOKEN_PREFIX =
  /\b(?:sk-|sk_live_|pk_live_|rk_live_|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|xapp-|npm_|hf_|AIza|AKIA|ASIA)[A-Za-z0-9_-]{8,}/gu;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@\S+/giu;
const EMAIL = /[A-Za-z0-9.!#$%&'*+=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
// A quoted absolute path, spaces included.
const QUOTED_PATH =
  /(["'\x60])(?:\/[^"'\x60\n]*\/|~\/|file:\/\/|[A-Za-z]:[\\/]|\[redacted\][\\/])[^"'\x60\n]*\1/gu;
// Absolute paths with two or more segments, `~/` paths, `file://` URLs and drive paths, plus the
// tail of a path whose known prefix was already redacted. URLs, `3/10`, `and/or` and one-segment
// paths such as `/compact` do not match. A path also takes each following word that holds a
// separator, so an unquoted `/home/a/My Project/b.txt` goes whole.
const PATH_SEGMENT = String.raw`[^\s/\\"'\x60<>(){},;:|]+`;
const PATH = new RegExp(
  `(?:${[
    String.raw`\[redacted\](?:/${PATH_SEGMENT})+/?`,
    String.raw`(?<![\w.:/~-])(?:/${PATH_SEGMENT}){2,}/?`,
    String.raw`(?<![\w~-])~(?:/${PATH_SEGMENT})+/?`,
    String.raw`\bfile://(?:/${PATH_SEGMENT})+/?`,
    String.raw`\b[A-Za-z]:[\\/](?:${PATH_SEGMENT}[\\/]?)*`,
  ].join("|")})${String.raw`(?:[ \t]+[^\s/\\]*[\\/]\S*)*`}`,
  "gu",
);
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
 * Removes values the server knows are private to this caller, then file paths and
 * anything shaped like a secret, email address, or URL with credentials, and caps
 * the result at FEEDBACK_TEXT_MAX_CHARS characters.
 */
export function scrubFeedback(text: string, sensitive: ReadonlyArray<string>): string {
  // Bounds the scrubbing cost; the margin keeps a secret that crosses the cap whole.
  let scrubbed = Array.from(text)
    .slice(0, FEEDBACK_TEXT_MAX_CHARS * 4)
    .join("");
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
    .replaceAll(QUOTED_PATH, `$1${REDACTED}$1`)
    .replaceAll(PATH, REDACTED)
    .replaceAll(TOKEN_PREFIX, REDACTED)
    .replaceAll(JWT, REDACTED)
    .replaceAll(EMAIL, REDACTED)
    .replaceAll(LONG_RUN, (value) => (looksRandom(value) ? REDACTED : value));
  return Array.from(scrubbed).slice(0, FEEDBACK_TEXT_MAX_CHARS).join("");
}
