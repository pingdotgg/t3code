// Patterns for common credential shapes: private keys, provider API keys, GitHub/Slack/AWS/Google
// tokens, JWTs, and `password=`-style assignments.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b((?:api[_-]?key|secret|password|passwd|token|auth)[A-Za-z_]*\s*[:=]\s*)(?!\[REDACTED\])["']?[^\s"']{8,}["']?/gi,
];

/** Replaces things that look like keys, tokens, or passwords, and counts how many it replaced. */
export function redactSecrets(text: string): { readonly text: string; readonly redacted: number } {
  let redacted = 0;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix?: string) => {
      redacted++;
      return typeof prefix === "string" && match.startsWith(prefix)
        ? `${prefix}[REDACTED]`
        : "[REDACTED]";
    });
  }
  return { text: result, redacted };
}
