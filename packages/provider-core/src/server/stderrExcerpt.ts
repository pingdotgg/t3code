import { redactSecretAssignments, redactUrls } from "./failure.ts";

const STDERR_TAIL_MAX_CHARS = 4_096;

const PAIRING_URL_PATTERN = /https?:\/\/[^\s]*\/pair#[^\s]*/gi;
const SIGN_IN_URL_PATTERN = /https?:\/\/accounts\.google\.com[^\s]*/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi;
// A header value runs to the end of the line, whatever its scheme, quoting or separators.
const AUTHORIZATION_HEADER_PATTERN = /\bAuthorization:[^\r\n]*/gi;
const API_KEY_HEADER_PATTERN = /\bx-api-key:[^\r\n]*/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|ghp_[A-Za-z0-9]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b/g;

export function appendStderrTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= STDERR_TAIL_MAX_CHARS ? next : next.slice(-STDERR_TAIL_MAX_CHARS);
}

// A full tail may start mid-line, cutting a secret's name off from its value, so drop that line.
function dropPartialFirstLine(tail: string): string {
  if (tail.length < STDERR_TAIL_MAX_CHARS) return tail;
  const lineStart = tail.indexOf("\n");
  return lineStart < 0 ? "" : tail.slice(lineStart + 1);
}

export function sanitizeStderrExcerpt(
  text: string,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let result = dropPartialFirstLine(text).replaceAll("\0", "");
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
  return redactSecretAssignments(redactUrls(result)).trim();
}
