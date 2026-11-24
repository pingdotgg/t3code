import {
  buildAppleIntentThreadDeepLink,
  buildAppleIntentsSnapshot,
  diffAppleIntentsSnapshots,
  type AppleIntentsProjectionEnvironmentInput,
  type AppleIntentsSnapshot,
} from "@t3tools/client-runtime/apple-intents-projection";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type {
  AppleIntentAuthCredential,
  AppleIntentOnscreenContext,
  EnvironmentId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { getClientSettings, subscribeClientSettings } from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";
import { environmentSession } from "../../state/session";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteTarget } from "../../threadRoutes";

const SYNC_DEBOUNCE_MS = 400;
const SYNC_RETRY_BASE_MS = 2_000;
const SYNC_MAX_RETRIES = 5;

interface RawDesktopCredential {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly isLocal: boolean;
  readonly bearerToken: string | null;
}

const desktopAppleIntentsSourceAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const inputs: AppleIntentsProjectionEnvironmentInput[] = [];
  const rawCredentials: RawDesktopCredential[] = [];

  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const entry = catalog.entries.get(environmentId);
    if (!entry) continue;
    const shellState = get(environmentShell.stateValueAtom(environmentId));
    const snapshot = Option.getOrNull(shellState.snapshot);
    const connection = Option.getOrNull(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
    );
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    const isLocal = entry.target._tag === "PrimaryConnectionTarget";
    const httpBaseUrl = prepared?.httpBaseUrl ?? null;

    inputs.push({
      environmentId,
      label: entry.target.label,
      httpBaseUrl,
      isLocal,
      // A reconnected shell still serves its cached snapshot until it is live again.
      isConnected: connection?.phase === "connected" && shellState.status === "live",
      projects: snapshot?.projects ?? [],
      threads: snapshot?.threads ?? [],
    });

    if (httpBaseUrl) {
      // Remote DPoP connections sign with a non-extractable WebCrypto key the native extension cannot
      // use, so they get no intent credential: they stay searchable and openable, and Siri actions
      // report that the environment must be used from the app.
      const auth = prepared?.httpAuthorization ?? null;
      if (auth?._tag === "Bearer") {
        rawCredentials.push({
          environmentId,
          httpBaseUrl,
          isLocal,
          bearerToken: auth.token,
        });
      } else if (isLocal) {
        rawCredentials.push({
          environmentId,
          httpBaseUrl,
          isLocal: true,
          bearerToken: null,
        });
      }
    }
  }

  return { inputs, rawCredentials };
}).pipe(Atom.withLabel("web-desktop-apple-intents-source"));

let lastSnapshot: AppleIntentsSnapshot | null = null;
let lastCredentialSignature = "";
let lastOnscreenSignature = "";
// The native index persists across launches, so assume it holds data until a clear succeeds.
let nativeMayHoldData = true;
// Syncs and clears share one queue, so a write that started before a clear cannot land after it.
let syncQueue: Promise<void> = Promise.resolve();

type DesktopAppleIntentsBridge = NonNullable<
  NonNullable<typeof window.desktopBridge>["appleIntents"]
>;

function enqueueAppleIntentsWork(work: () => Promise<void>): Promise<void> {
  const run = syncQueue.then(work);
  syncQueue = run.catch(() => undefined);
  return run;
}

async function clearNativeIndex(bridge: DesktopAppleIntentsBridge): Promise<void> {
  try {
    await bridge.clearIndex();
    nativeMayHoldData = false;
  } finally {
    // A failed clear may have removed part of the index, so the next sync starts from scratch.
    lastSnapshot = null;
    lastCredentialSignature = "";
    lastOnscreenSignature = "";
  }
}

/** Clears the native index and credentials after any sync already in flight. */
export function clearDesktopAppleIntentsIndex(): Promise<void> {
  const bridge = window.desktopBridge?.appleIntents;
  if (!bridge) return Promise.resolve();
  return enqueueAppleIntentsWork(() => clearNativeIndex(bridge));
}

async function syncNativeIndex(
  bridge: DesktopAppleIntentsBridge,
  router: ReturnType<typeof useRouter>,
): Promise<void> {
  const settings = getClientSettings();
  const enabled = settings.appleIntentsEnabled;

  if (!enabled) {
    if (nativeMayHoldData) await clearNativeIndex(bridge);
    return;
  }

  const source = appAtomRegistry.get(desktopAppleIntentsSourceAtom);
  const nextSnapshot = buildAppleIntentsSnapshot(source.inputs, {
    indexMessagePreviews: settings.appleIntentsIndexMessagePreviews,
    nowMs: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    resolve: m,
  });
  const diff = diffAppleIntentsSnapshots(lastSnapshot, nextSnapshot);
  if (diff.hasChanges) {
    nativeMayHoldData = true;
    try {
      await bridge.syncIndex(diff.delta);
    } catch (error) {
      // Native storage may have committed part of the delta, so resync everything next time.
      lastSnapshot = null;
      throw error;
    }
    lastSnapshot = nextSnapshot;
  }

  const routeParams = (router.state.matches.at(-1)?.params ?? {}) as Record<
    string,
    string | undefined
  >;
  const onscreen = readOnscreenContext(routeParams, enabled);
  const onscreenSig = JSON.stringify(onscreen);
  if (onscreenSig !== lastOnscreenSignature) {
    await bridge.setOnscreenContext(onscreen);
    lastOnscreenSignature = onscreenSig;
  }

  const needsLocalToken = source.rawCredentials.some(
    (item) => item.isLocal && item.bearerToken === null,
  );
  const localToken = needsLocalToken
    ? await readDesktopPrimaryBearerToken().catch(() => null)
    : null;
  const credentials: AppleIntentAuthCredential[] = [];
  for (const item of source.rawCredentials) {
    const accessToken = item.bearerToken ?? (item.isLocal ? localToken : null);
    if (!accessToken) continue;
    credentials.push({
      environmentId: item.environmentId,
      httpBaseUrl: item.httpBaseUrl,
      accessToken,
      authScheme: "Bearer",
    });
  }
  const credSig = JSON.stringify(credentials);
  if (credSig !== lastCredentialSignature) {
    nativeMayHoldData = true;
    await bridge.syncAuthCredentials(credentials);
    lastCredentialSignature = credSig;
  }
}

function readOnscreenContext(
  routeParams: Record<string, string | undefined>,
  enabled: boolean,
): AppleIntentOnscreenContext {
  if (!enabled) return null;
  const target = resolveThreadRouteTarget(routeParams);
  if (target?.kind !== "server") return null;
  const shell = readThreadShell(target.threadRef);
  if (!shell) return null;
  return {
    kind: "thread",
    environmentId: target.threadRef.environmentId,
    threadId: target.threadRef.threadId,
    title: shell.title.trim() || m(msg("Untitled Thread")),
    deepLinkUrl: buildAppleIntentThreadDeepLink(
      target.threadRef.environmentId,
      target.threadRef.threadId,
    ),
  };
}

export function DesktopAppleIntentsCoordinator() {
  const router = useRouter();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors environment snapshots, onscreen thread context, and credentials into the native macOS Apple Intents bridge
  useEffect(() => {
    const bridge = window.desktopBridge?.appleIntents;
    if (!bridge) return;

    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    const cleanups: Array<() => void> = [];

    // Unchanged sources never re-trigger a flush, so a failed sync retries on its own.
    const scheduleRetry = () => {
      if (disposed || retryTimer !== null || retryAttempt >= SYNC_MAX_RETRIES) return;
      const delay = SYNC_RETRY_BASE_MS * 2 ** retryAttempt;
      retryAttempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        flush();
      }, delay);
    };

    const flush = () => {
      void enqueueAppleIntentsWork(async () => {
        if (disposed) return;
        await syncNativeIndex(bridge, router);
      }).then(
        () => {
          retryAttempt = 0;
        },
        (error: unknown) => {
          console.warn("[apple-intents] desktop sync failed", error);
          scheduleRetry();
        },
      );
    };

    const scheduleFlush = () => {
      if (disposed) return;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        flush();
      }, SYNC_DEBOUNCE_MS);
    };

    void bridge
      .getStatus()
      .then((status) => {
        if (disposed || !status.available) return;
        cleanups.push(
          appAtomRegistry.subscribe(desktopAppleIntentsSourceAtom, scheduleFlush, {
            immediate: true,
          }),
          subscribeClientSettings(scheduleFlush),
          router.subscribe("onResolved", scheduleFlush),
        );
      })
      .catch(() => undefined);

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
      for (const cleanup of cleanups) cleanup();
    };
  }, [router]);

  return null;
}
