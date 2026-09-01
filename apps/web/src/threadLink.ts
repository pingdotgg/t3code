import type { ScopedThreadRef } from "@t3tools/contracts";

import { readPreparedConnection } from "~/state/session";
import { buildThreadRoutePath } from "./threadRoutes";

function browserOrigin(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.startsWith("http://") || value.startsWith("https://") ? value : null;
}

/**
 * The address a browser can open to land on a thread.
 *
 * In a browser the answer is the address bar: the app is served from the
 * origin the user is already on. The desktop app has no address bar and its
 * renderer origin (`t3code://app`) means nothing outside the app, so the link
 * falls back to the environment's own HTTP base URL — the T3 server that owns
 * the thread and serves the web client for it. Environments reachable only
 * through a target we cannot express as an HTTP origin get no link.
 */
export function resolveThreadLink(input: {
  /** `window.location.origin`, or null off a browser origin. */
  readonly clientOrigin: string | null;
  readonly environmentHttpBaseUrl: string | null;
  readonly ref: ScopedThreadRef;
}): string | null {
  const base = browserOrigin(input.clientOrigin) ?? browserOrigin(input.environmentHttpBaseUrl);
  if (base === null) {
    return null;
  }
  try {
    return new URL(buildThreadRoutePath(input.ref), base).toString();
  } catch {
    return null;
  }
}

/** `resolveThreadLink` against this client's origin and live connection. */
export function readThreadLink(ref: ScopedThreadRef): string | null {
  return resolveThreadLink({
    clientOrigin: typeof window === "undefined" ? null : window.location.origin,
    environmentHttpBaseUrl: readPreparedConnection(ref.environmentId)?.httpBaseUrl ?? null,
    ref,
  });
}
