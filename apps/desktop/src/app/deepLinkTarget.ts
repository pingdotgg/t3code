import * as Option from "effect/Option";

import { DESKTOP_HOST } from "../electron/ElectronProtocol.ts";

/**
 * Extracts the in-app target from a deep link.
 *
 * A link is untrusted input from any web page, so this only ever yields a path
 * within the renderer's own origin: a foreign scheme, a foreign host, or a
 * protocol-relative path (which a router would read as another origin) all
 * resolve to none rather than reaching the renderer.
 */
export function parseDeepLinkTarget(rawUrl: unknown, scheme: string): Option.Option<string> {
  if (typeof rawUrl !== "string") return Option.none();
  const trimmedUrl = rawUrl.trim();
  if (trimmedUrl.length === 0) return Option.none();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    return Option.none();
  }

  if (parsedUrl.protocol !== `${scheme}:` || parsedUrl.host !== DESKTOP_HOST) {
    return Option.none();
  }

  const target = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  if (!target.startsWith("/") || target.startsWith("//")) {
    return Option.none();
  }

  return Option.some(target);
}

/**
 * Reduces a target to bounded diagnostics.
 *
 * A link comes from outside the app and its query or fragment can carry a
 * one-time token, so logs and spans record the route shape instead of the value.
 */
export function describeDeepLinkTarget(target: string): {
  readonly path: string;
  readonly hasQuery: boolean;
  readonly hasFragment: boolean;
} {
  const queryIndex = target.search(/[?#]/u);
  return {
    path: queryIndex === -1 ? target : target.slice(0, queryIndex),
    hasQuery: target.includes("?"),
    hasFragment: target.includes("#"),
  };
}

/**
 * Finds the deep link among process arguments.
 *
 * Linux and Windows deliver links as an argv entry rather than an event, mixed
 * in with Chromium's own switches, so every argument gets tried and the first
 * one addressing our scheme wins.
 */
export function findDeepLinkTarget(
  argv: ReadonlyArray<string>,
  scheme: string,
): Option.Option<string> {
  for (const argument of argv) {
    const target = parseDeepLinkTarget(argument, scheme);
    if (Option.isSome(target)) {
      return target;
    }
  }

  return Option.none();
}
