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
import { environmentSession } from "../../state/session";
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
const SYNC_RETRY_BASE_MS = 2_000;
const SYNC_MAX_RETRIES = 5;

const activeOnscreenThreadRefAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:apple-intents-onscreen-thread-ref"),
);

const appleIntentsSourceAtom = Atom.make((get) => {
  const preferencesResult = get(mobilePreferencesAtom);
  // Until the saved opt-out is known, nothing may reach the native index; a failed read stays unknown.
  const preferencesReady = AsyncResult.isSuccess(preferencesResult);
  const preferences = preferencesReady ? preferencesResult.value : {};
  const enabled = preferences.appleIntentsEnabled ?? true;
  const indexMessagePreviews = preferences.appleIntentsIndexMessagePreviews ?? false;
  const connectionsById = get(savedConnectionsByIdAtom);
  const inputs: AppleIntentsProjectionEnvironmentInput[] = [];
  const rawCredentials: Array<{
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
    readonly accessToken: string;
    readonly authScheme: "Bearer" | "DPoP";
    readonly relayManaged: boolean;
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

    // The prepared connection carries the authorization of the route in use, including direct DPoP.
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    const authorization = prepared?.httpAuthorization ?? null;
    if (prepared === null || authorization === null) continue;
    rawCredentials.push({
      environmentId,
      httpBaseUrl: prepared.httpBaseUrl,
      accessToken: authorization._tag === "Dpop" ? authorization.accessToken : authorization.token,
      authScheme: authorization._tag === "Dpop" ? "DPoP" : "Bearer",
      relayManaged: prepared.target._tag === "RelayConnectionTarget",
    });
  }

  const onscreenRef = get(activeOnscreenThreadRefAtom);
  const onscreenShell =
    onscreenRef === null ? null : get(environmentThreadShells.threadShellAtom(onscreenRef));

  return {
    preferencesReady,
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
// The native index persists across launches, so assume it holds data until a clear succeeds.
let nativeMayHoldData = true;
// Syncs and clears share one queue, so a write that started before a clear cannot land after it.
let syncQueue: Promise<void> = Promise.resolve();

function enqueueAppleIntentsWork(work: () => Promise<void>): Promise<void> {
  const run = syncQueue.then(work);
  syncQueue = run.catch(() => undefined);
  return run;
}

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

async function clearNativeIndex(): Promise<void> {
  try {
    await clearAppleIntentsNativeIndex();
    nativeMayHoldData = false;
  } finally {
    // A failed clear may have removed part of the index, so the next sync starts from scratch.
    lastSnapshot = null;
    lastCredentialSignature = "";
    lastOnscreenSignature = "";
  }
}

/** Clears the native index and credentials after any sync already in flight. */
export function clearAppleIntentsIndex(): Promise<void> {
  return enqueueAppleIntentsWork(clearNativeIndex);
}

async function syncNativeIndex(source: Atom.Type<typeof appleIntentsSourceAtom>): Promise<void> {
  if (!source.enabled) {
    if (nativeMayHoldData) await clearNativeIndex();
    return;
  }

  const nextSnapshot = buildAppleIntentsSnapshot(source.inputs, {
    indexMessagePreviews: source.indexMessagePreviews,
    nowMs: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    resolve: m,
  });
  const diff = diffAppleIntentsSnapshots(lastSnapshot, nextSnapshot);
  if (diff.hasChanges) {
    nativeMayHoldData = true;
    try {
      await syncAppleIntentsIndex(diff.delta);
    } catch (error) {
      // Native storage may have committed part of the delta, so resync everything next time.
      lastSnapshot = null;
      throw error;
    }
    lastSnapshot = nextSnapshot;
  }

  const onscreenSig = JSON.stringify(source.onscreen);
  if (onscreenSig !== lastOnscreenSignature) {
    setAppleIntentsOnscreenContext(source.onscreen);
    lastOnscreenSignature = onscreenSig;
  }

  const needsDpop = source.rawCredentials.some((item) => item.authScheme === "DPoP");
  const dpopScalar = needsDpop ? await readDpopPrivateScalarBase64Url() : null;
  const credentials: AppleIntentAuthCredential[] = source.rawCredentials.map((item) => ({
    environmentId: item.environmentId,
    httpBaseUrl: item.httpBaseUrl,
    accessToken: item.accessToken,
    authScheme: item.authScheme,
    relayManaged: item.relayManaged,
    ...(item.authScheme === "DPoP" && dpopScalar ? { dpopKeyRef: dpopScalar } : {}),
  }));
  const credSig = JSON.stringify(credentials);
  if (credSig !== lastCredentialSignature) {
    nativeMayHoldData = true;
    await syncAppleIntentsAuthCredentials(credentials);
    lastCredentialSignature = credSig;
  }
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
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;

  // An unchanged source never re-triggers the subscription, so a failed sync retries on its own.
  const scheduleRetry = () => {
    if (disposed || retryTimer !== null || retryAttempt >= SYNC_MAX_RETRIES) return;
    const delay = SYNC_RETRY_BASE_MS * 2 ** retryAttempt;
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush(appAtomRegistry.get(appleIntentsSourceAtom));
    }, delay);
  };

  const flush = (source: Atom.Type<typeof appleIntentsSourceAtom>) => {
    void enqueueAppleIntentsWork(async () => {
      if (disposed || !source.preferencesReady) return;
      await syncNativeIndex(source);
    }).then(
      () => {
        retryAttempt = 0;
      },
      (error: unknown) => {
        console.warn("[apple-intents] sync failed", error);
        scheduleRetry();
      },
    );
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
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    unsubscribe();
  };
}
