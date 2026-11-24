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
      isConnected: connection?.phase === "connected",
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

function resetDesktopAppleIntentsSyncCache(): void {
  lastSnapshot = null;
  lastCredentialSignature = "";
  lastOnscreenSignature = "";
}

/** Clears the native index and credentials; the sync cache resets only once the clear succeeds. */
export async function clearDesktopAppleIntentsIndex(): Promise<void> {
  const bridge = window.desktopBridge?.appleIntents;
  if (!bridge) return;
  await bridge.clearIndex();
  resetDesktopAppleIntentsSyncCache();
  nativeMayHoldData = false;
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
    let syncQueue: Promise<void> = Promise.resolve();
    const cleanups: Array<() => void> = [];

    const flush = () => {
      syncQueue = syncQueue
        .then(async () => {
          if (disposed) return;

          const settings = getClientSettings();
          const enabled = settings.appleIntentsEnabled;

          if (!enabled) {
            if (nativeMayHoldData) await clearDesktopAppleIntentsIndex();
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
            await bridge.syncIndex(diff.delta);
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
        })
        .catch((error: unknown) => {
          console.warn("[apple-intents] desktop sync failed", error);
        });
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
      for (const cleanup of cleanups) cleanup();
    };
  }, [router]);

  return null;
}
