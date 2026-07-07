import * as Option from "effect/Option";

/** OS-registered scheme for thread deep links (`t3://thread/<threadId>`). */
export const DESKTOP_THREAD_DEEP_LINK_SCHEME = "t3";

export function parseThreadDeepLinkUrl(rawUrl: string): Option.Option<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return Option.none();
  }

  if (parsed.protocol !== `${DESKTOP_THREAD_DEEP_LINK_SCHEME}:` || parsed.hostname !== "thread") {
    return Option.none();
  }

  const threadId = parsed.pathname.replace(/^\/+/, "");
  return threadId.length > 0 ? Option.some(threadId) : Option.none();
}

export function findThreadDeepLinkInArgv(argv: readonly string[]): Option.Option<string> {
  for (const arg of argv) {
    const threadId = parseThreadDeepLinkUrl(arg);
    if (Option.isSome(threadId)) {
      return threadId;
    }
  }
  return Option.none();
}
