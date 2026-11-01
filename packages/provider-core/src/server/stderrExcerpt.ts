import { redactSecretAssignments } from "./failure.ts";

const STDERR_TAIL_MAX_CHARS = 4_096;

const PAIRING_URL_PATTERN = /https?:\/\/[^\s]*\/pair#[^\s]*/gi;
const SIGN_IN_URL_PATTERN = /https?:\/\/accounts\.google\.com[^\s]*/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi;
// Header values may contain `,` and `;`, which end a generic assignment value.
const AUTHORIZATION_HEADER_PATTERN = /\bAuthorization:[ \t]*(?:(?:Bearer|Basic|Token)[ \t]+)?\S+/gi;
const API_KEY_HEADER_PATTERN = /\bx-api-key:[ \t]*\S+/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|ghp_[A-Za-z0-9]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b/g;

// A truncated tail starts at the next line so a secret's name is never cut off from its value.
export function appendStderrTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  if (next.length <= STDERR_TAIL_MAX_CHARS) return next;
  const window = next.slice(-STDERR_TAIL_MAX_CHARS);
  const lineStart = window.indexOf("\n");
  return lineStart < 0 ? "" : window.slice(lineStart + 1);
}

export function sanitizeStderrExcerpt(
  text: string,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let result = text.replaceAll("\0", "");
  const homes = [environment.HOME, environment.USERPROFILE, homeDirectory].filter(
    (value): value is string => typeof value === "string" && value.length > 1,
  );
  for (const home of new Set(homes)) {
    result = result.split(home).join("~");
  }
  result = result
    .replace(PAIRING_URL_PATTERN, "[pairing-url]")
    .replace(SIGN_IN_URL_PATTERN, "[sign-in-url]")
    .replace(AUTHORIZATION_HEADER_PATTERN, "Authorization: [REDACTED]")
    .replace(API_KEY_HEADER_PATTERN, "x-api-key: [REDACTED]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(SECRET_TOKEN_PATTERN, "[redacted]");
  return redactSecretAssignments(result).trim();
}
