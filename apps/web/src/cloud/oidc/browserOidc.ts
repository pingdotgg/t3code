import { isDesktopOidcCallbackUrl, OIDC_CALLBACK_PATH } from "@t3tools/shared/oidc";

import { resolveOidcPublicConfig } from "../publicConfig";
import {
  createOidcController,
  type KeyValueStore,
  type OidcController,
} from "@t3tools/client-runtime/relay";

// Storage throws in some private-browsing modes; a session then lasts until the tab closes.
const storageOrMemory = (read: () => Storage): KeyValueStore => {
  try {
    return read();
  } catch {
    const entries = new Map<string, string>();
    return {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => void entries.set(key, value),
      removeItem: (key) => void entries.delete(key),
    };
  }
};

let controller: OidcController | null = null;

/** The one controller for this page; null when the build has no OpenID Connect provider. */
export function getBrowserOidcController(): OidcController | null {
  const config = resolveOidcPublicConfig();
  if (config === null) return null;
  controller ??= createOidcController({
    config,
    redirectUri: `${window.location.origin}${OIDC_CALLBACK_PATH}`,
    sessions: storageOrMemory(() => window.localStorage),
    pending: storageOrMemory(() => window.sessionStorage),
    navigate: (url) => window.location.assign(url),
    ...(navigator.locks === undefined
      ? {}
      : { withRefreshLock: (run) => navigator.locks.request("t3-oidc-refresh", run) }),
  });
  return controller;
}

let abandonDesktopSignIn: (() => void) | null = null;

/**
 * Electron signs in through the system browser (RFC 8252): the identity provider redirects to the
 * app's private-use scheme, and the main process hands that link back over `webLinks`.
 */
export function signInThroughDesktopBrowser(controller: OidcController): Promise<string> | null {
  const bridge = window.desktopBridge;
  if (bridge === undefined) return null;
  return controller.signInWithPrompt(async (authorizeUrl) => {
    abandonDesktopSignIn?.();
    const callback = new Promise<string>((resolve, reject) => {
      const unsubscribe = bridge.webLinks.onOpen((url) => {
        if (!isDesktopOidcCallbackUrl(url)) return;
        abandonDesktopSignIn = null;
        unsubscribe();
        resolve(url);
      });
      abandonDesktopSignIn = () => {
        unsubscribe();
        reject(new Error("A newer sign-in replaced this one."));
      };
    });
    await bridge.openExternal(authorizeUrl);
    return callback;
  });
}
