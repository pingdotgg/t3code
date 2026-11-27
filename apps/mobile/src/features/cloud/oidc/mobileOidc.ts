import {
  createOidcController,
  type KeyValueStore,
  type OidcController,
} from "@t3tools/client-runtime/relay";
import * as AuthSession from "expo-auth-session";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

import { resolveCloudPublicConfig } from "../publicConfig";
import { secureStoreKey } from "./secureStoreKey";

// SecureStore deletes asynchronously, so the map answers until the keychain catches up.
function secureSessionStore(): KeyValueStore {
  const shadow = new Map<string, string | null>();
  return {
    getItem: (key) =>
      shadow.has(key) ? shadow.get(key)! : SecureStore.getItem(secureStoreKey(key)),
    setItem: (key, value) => {
      shadow.set(key, value);
      SecureStore.setItem(secureStoreKey(key), value);
    },
    removeItem: (key) => {
      shadow.set(key, null);
      // A rejected delete would leave the token to be restored after a restart; blank it instead,
      // which reads back as no session.
      SecureStore.deleteItemAsync(secureStoreKey(key)).catch(() => {
        try {
          SecureStore.setItem(secureStoreKey(key), "");
        } catch {
          // Nothing more can be done; the in-memory shadow still reports signed out.
        }
      });
    },
  };
}

function memoryStore(): KeyValueStore {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

const redirectUri = AuthSession.makeRedirectUri({ path: "oidc" });

let controller: OidcController | null | undefined;

/** The one controller for this app; null when the build has no OpenID Connect provider. */
export function getMobileOidcController(): OidcController | null {
  if (controller !== undefined) return controller;
  const { oidc } = resolveCloudPublicConfig();
  controller =
    oidc.issuer && oidc.clientId
      ? createOidcController({
          config: { issuer: oidc.issuer, clientId: oidc.clientId },
          redirectUri,
          sessions: secureSessionStore(),
          pending: memoryStore(),
          // Hermes has no Web Crypto.
          crypto: {
            randomBytes: ExpoCrypto.getRandomBytes,
            sha256: (data) => ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data),
          },
          navigate: () => {
            throw new Error("The mobile app signs in through an in-app browser.");
          },
        })
      : null;
  return controller;
}

/** Shows the provider's sign-in page in the system browser sheet and finishes the sign-in. */
export function signInWithBrowser(oidc: OidcController): Promise<string> {
  return oidc.signInWithPrompt(async (authorizeUrl) => {
    const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, redirectUri);
    if (result.type !== "success") throw new Error("Sign-in was cancelled.");
    return result.url;
  });
}
