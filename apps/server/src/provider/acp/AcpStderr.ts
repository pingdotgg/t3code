// @effect-diagnostics nodeBuiltinImport:off -- The excerpt sanitizer masks the home directory, which only the Node os module can resolve.
import * as NodeOS from "node:os";

/** Last few KiB of ACP child stderr kept for startup / exit diagnostics. */
export const ACP_STDERR_TAIL_MAX_CHARS = 4_096;

const PAIRING_URL_PATTERN = /https?:\/\/[^\s]*\/pair#[^\s]*/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi;
const BASIC_AUTH_PATTERN = /\bAuthorization:\s*Basic\s+\S+/gi;
const API_KEY_HEADER_PATTERN = /\bx-api-key:\s*\S+/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9-]{7,}|ghp_[A-Za-z0-9]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b/g;

export function appendAcpStderrTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= ACP_STDERR_TAIL_MAX_CHARS ? next : next.slice(-ACP_STDERR_TAIL_MAX_CHARS);
}

/** Bounded, redacted excerpt safe to put on user-facing adapter errors. */
export function sanitizeAcpStderrExcerpt(
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let result = text.replaceAll("\0", "");
  const homes = [environment.HOME, environment.USERPROFILE, NodeOS.homedir()].filter(
    (value): value is string => typeof value === "string" && value.length > 1,
  );
  for (const home of new Set(homes)) {
    result = result.split(home).join("~");
  }
  result = result
    .replace(PAIRING_URL_PATTERN, "[pairing-url]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(BASIC_AUTH_PATTERN, "Authorization: Basic [redacted]")
    .replace(API_KEY_HEADER_PATTERN, "x-api-key: [redacted]")
    .replace(SECRET_TOKEN_PATTERN, "[redacted]");
  return result.trim();
}
