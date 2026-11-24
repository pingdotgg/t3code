import type { NavigationState } from "@react-navigation/native";
import {
  buildAppleIntentThreadDeepLink,
  buildAppleIntentsSnapshot,
  diffAppleIntentsSnapshots,
  type AppleIntentsProjectionEnvironmentInput,
  type AppleIntentsSnapshot,
} from "@t3tools/client-runtime/apple-intents-projection";
import type { AppleIntentAuthCredential, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";
import { msg } from "gt-react-native";
import { Platform } from "react-native";

import { m } from "../../i18n/messages";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import {
  environmentConnectedAtom,
  savedConnectionsByIdAtom,
} from "../../state/use-remote-environment-registry";
import { activeThreadRef } from "../shortcuts/appShortcuts";
import {
  clearAppleIntentsNativeIndex,
  isAppleIntentsSupported,
  setAppleIntentsOnscreenContext,
  syncAppleIntentsAuthCredentials,
  syncAppleIntentsIndex,
} from "./nativeBridge";

const DPOP_PROOF_KEY_STORAGE_KEY = "t3code.cloud.dpop-proof-key";
const SYNC_DEBOUNCE_MS = 400;

const activeOnscreenThreadRefAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:apple-intents-onscreen-thread-ref"),
);

const appleIntentsSourceAtom = Atom.make((get) => {
  const preferencesResult = get(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const enabled = preferences.appleIntentsEnabled ?? true;
  const indexMessagePreviews = preferences.appleIntentsIndexMessagePreviews ?? false;
  const connectionsById = get(savedConnectionsByIdAtom);
  const inputs: AppleIntentsProjectionEnvironmentInput[] = [];
  const rawCredentials: Array<{
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
    readonly accessToken: string;
    readonly authScheme: "Bearer" | "DPoP";
  }> = [];

  for (const [envKey, connection] of Object.entries(connectionsById)) {
    const environmentId = envKey as EnvironmentId;
    const shellState = get(environmentShell.stateValueAtom(environmentId));
    const snapshot = Option.getOrNull(shellState.snapshot);
    const isConnected = get(environmentConnectedAtom(environmentId));

    inputs.push({
      environmentId,
      label: connection.environmentLabel,
      httpBaseUrl: connection.httpBaseUrl || null,
      isLocal: false,
      isConnected,
      projects: snapshot?.projects ?? [],
      threads: snapshot?.threads ?? [],
    });

    if (connection.httpBaseUrl) {
      if (connection.authenticationMethod === "dpop" && connection.dpopAccessToken) {
        rawCredentials.push({
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          accessToken: connection.dpopAccessToken,
          authScheme: "DPoP",
        });
      } else if (connection.bearerToken) {
        rawCredentials.push({
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          accessToken: connection.bearerToken,
          authScheme: "Bearer",
        });
      }
    }
  }

  const onscreenRef = get(activeOnscreenThreadRefAtom);
  const onscreenShell =
    onscreenRef === null ? null : get(environmentThreadShells.threadShellAtom(onscreenRef));

  return {
    enabled,
    indexMessagePreviews,
    inputs,
    rawCredentials,
    onscreen:
      enabled && onscreenRef !== null && onscreenShell !== null
        ? {
            kind: "thread" as const,
            environmentId: onscreenRef.environmentId,
            threadId: onscreenRef.threadId,
            title: onscreenShell.title || m(msg("Untitled Thread")),
            deepLinkUrl: buildAppleIntentThreadDeepLink(
              onscreenRef.environmentId,
              onscreenRef.threadId,
            ),
          }
        : null,
  };
}).pipe(Atom.withLabel("mobile:apple-intents-source"));

let lastSnapshot: AppleIntentsSnapshot | null = null;
let lastCredentialSignature = "";
let lastOnscreenSignature = "";

async function readDpopPrivateScalarBase64Url(): Promise<string | null> {
  try {
    const raw = await SecureStore.getItemAsync(DPOP_PROOF_KEY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { readonly d?: unknown };
    return typeof parsed.d === "string" && parsed.d.length > 0 ? parsed.d : null;
  } catch {
    return null;
  }
}

export async function clearAppleIntentsIndex(): Promise<void> {
  lastSnapshot = null;
  lastCredentialSignature = "";
  lastOnscreenSignature = "";
  await clearAppleIntentsNativeIndex();
}

export function recordAppleIntentsNavigationState(state: NavigationState | undefined): void {
  if (Platform.OS !== "ios") return;
  appAtomRegistry.set(activeOnscreenThreadRefAtom, state ? activeThreadRef(state) : null);
}

export function installAppleIntents(): () => void {
  if (Platform.OS !== "ios" || !isAppleIntentsSupported()) {
    return () => {};
  }

  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let syncQueue: Promise<void> = Promise.resolve();

  const flush = (source: Atom.Type<typeof appleIntentsSourceAtom>) => {
    syncQueue = syncQueue
      .then(async () => {
        if (disposed) return;

        const onscreenSig = JSON.stringify(source.onscreen);
        if (onscreenSig !== lastOnscreenSignature) {
          lastOnscreenSignature = onscreenSig;
          setAppleIntentsOnscreenContext(source.onscreen);
        }

        if (!source.enabled) {
          if (lastSnapshot !== null || lastCredentialSignature !== "") {
            await clearAppleIntentsIndex();
          }
          return;
        }

        const nextSnapshot = buildAppleIntentsSnapshot(source.inputs, {
          indexMessagePreviews: source.indexMessagePreviews,
          nowMs: DateTime.toEpochMillis(DateTime.nowUnsafe()),
          resolve: m,
        });
        const diff = diffAppleIntentsSnapshots(lastSnapshot, nextSnapshot);
        if (diff.hasChanges) {
          await syncAppleIntentsIndex(diff.delta);
          lastSnapshot = nextSnapshot;
        }

        const needsDpop = source.rawCredentials.some((item) => item.authScheme === "DPoP");
        const dpopScalar = needsDpop ? await readDpopPrivateScalarBase64Url() : null;
        const credentials: AppleIntentAuthCredential[] = source.rawCredentials.map((item) => ({
          environmentId: item.environmentId,
          httpBaseUrl: item.httpBaseUrl,
          accessToken: item.accessToken,
          authScheme: item.authScheme,
          ...(item.authScheme === "DPoP" && dpopScalar ? { dpopKeyRef: dpopScalar } : {}),
        }));
        const credSig = JSON.stringify(credentials);
        if (credSig !== lastCredentialSignature) {
          await syncAppleIntentsAuthCredentials(credentials);
          lastCredentialSignature = credSig;
        }
      })
      .catch((error: unknown) => {
        console.warn("[apple-intents] sync failed", error);
      });
  };

  const unsubscribe = appAtomRegistry.subscribe(
    appleIntentsSourceAtom,
    (source) => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        flush(source);
      }, SYNC_DEBOUNCE_MS);
    },
    { immediate: true },
  );

  return () => {
    disposed = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    unsubscribe();
  };
}
