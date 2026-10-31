import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DEFAULT_HOSTED_APP_URL } from "./connectAuth.ts";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);
const decodeThreadId = Schema.decodeOption(ThreadId);

export function threadDeepLink(ref: ScopedThreadRef): string {
  return new URL(
    `/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`,
    DEFAULT_HOSTED_APP_URL,
  ).href;
}

/** Public thread addresses carry identity only; connecting still requires authorization. */
export function parseThreadDeepLink(value: string): ScopedThreadRef | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    const web = url.origin === DEFAULT_HOSTED_APP_URL;
    const app =
      ["t3code:", "t3code-dev:", "t3code-preview:"].includes(url.protocol) &&
      url.host === "threads";
    if (!web && !app) return null;
    const match = /^\/(?!settings\/|projects\/|draft\/)([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const environmentId = Option.getOrNull(decodeEnvironmentId(decodeURIComponent(match[1]!)));
    const threadId = Option.getOrNull(decodeThreadId(decodeURIComponent(match[2]!)));
    return environmentId === null || threadId === null ? null : { environmentId, threadId };
  } catch {
    return null;
  }
}
