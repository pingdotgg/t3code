import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type {
  DeviceServiceState,
  EnvironmentId,
  PreviewSessionSnapshot,
  PrinterServiceState,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { getClientSettings } from "../../hooks/useSettings";
import {
  browserMiniPlayerSource,
  type PreviewMiniPlayerSource,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import {
  previewStateAtom,
  previewThreadRefsAtom,
  type ThreadPreviewState,
} from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { deviceEnvironment } from "../../state/device";
import { printerEnvironment } from "../../state/printer";
import { readEnvironmentSupportsServerBrowser } from "../../state/entities";
import { environmentSummaries } from "../../state/presentation";

/**
 * Shows browsers an agent or another client revealed for a thread: floating
 * over chat, or focusing an existing panel tab when the reveal is forced.
 */
export function revealServerTabs(
  threadRef: ScopedThreadRef,
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  options: { readonly autoShowFloatingPreview: boolean },
): void {
  if (!readEnvironmentSupportsServerBrowser(threadRef.environmentId)) return;
  for (const session of sessions) {
    const force = session.revealRequest?.force === true;
    if (!options.autoShowFloatingPreview && !force) continue;
    const surface = useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.find(
        (surface) => surface.kind === "preview" && surface.resourceId === session.tabId,
      );
    if (surface && force) {
      useRightPanelStore.getState().revealSurface(threadRef, surface.id);
    } else if (!surface) {
      usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(session.tabId));
    }
  }
}

/**
 * Keeps a thread's browser panel tabs and floating browser in step with its
 * preview sessions. Server-hosted sessions are only complete once the first
 * list has loaded; before that, a missing session is not a closed one.
 */
export function followPreviewSessions(threadRef: ScopedThreadRef, state: ThreadPreviewState): void {
  if (readEnvironmentSupportsServerBrowser(threadRef.environmentId) && !state.listLoaded) return;
  const sessions = Object.values(state.sessions);
  useRightPanelStore.getState().reconcileBrowserSurfaces(
    threadRef,
    sessions.map((session) => session.tabId),
    new Set(
      sessions
        .filter((session) => session.runtime === "server" && session.reveal === false)
        .map((session) => session.tabId),
    ),
  );
  const miniPlayer = usePreviewMiniPlayerStore.getState();
  const source = miniPlayer.byThreadKey[scopedThreadKey(threadRef)]?.source;
  if (source?.kind === "browser" && !state.sessions[source.tabId]) miniPlayer.close(threadRef);
}

/**
 * Server tabs that are new, or carry a new reveal request, since `previous`.
 * Nothing is fresh until the first list has loaded: that list is the baseline,
 * so a reload never reopens previews the user dismissed. A tab this client was
 * closing comes back without a reveal if the close fails.
 */
function freshlyRevealedServerTabs(
  previous: ThreadPreviewState,
  next: ThreadPreviewState,
): ReadonlyArray<PreviewSessionSnapshot> {
  if (!previous.listLoaded || previous.sessions === next.sessions) return [];
  return Object.values(next.sessions).filter((session) => {
    if (session.runtime !== "server" || session.reveal !== true) return false;
    if (previous.suppressedTabIds.has(session.tabId)) return false;
    const before = previous.sessions[session.tabId];
    const requested = session.revealRequest;
    return requested ? before?.revealRequest?.id !== requested.id : before === undefined;
  });
}

function followThread(threadKey: string, threadRef: ScopedThreadRef): () => void {
  const atom = previewStateAtom(threadKey);
  let previous = appAtomRegistry.get(atom);
  return appAtomRegistry.subscribe(atom, (next) => {
    const before = previous;
    previous = next;
    // Reveals run first so a revealed tab floats before it gains a panel tab.
    const revealed = freshlyRevealedServerTabs(before, next);
    if (revealed.length > 0) {
      revealServerTabs(threadRef, revealed, {
        autoShowFloatingPreview: getClientSettings().browserAutoShowFloatingPreview,
      });
    }
    if (before.sessions !== next.sessions || before.listLoaded !== next.listLoaded) {
      followPreviewSessions(threadRef, next);
    }
  });
}

// `openedAt` tells a session apart from one that ended and reopened on the same device while
// this client was disconnected.
const sessionKey = (session: DeviceServiceState["sessions"][number]) =>
  `${session.threadId}:${session.hostId}:${session.deviceId}:${session.openedAt}`;

/**
 * Per environment: the device sessions seen in the last snapshot. The first
 * snapshot is a baseline, so persisted tabs restore themselves and existing
 * sessions never resurrect tabs the user closed. Baselines outlive a
 * disconnect, so a device an agent opened during the gap still shows.
 */
const deviceSessionBaselines = new Map<EnvironmentId, ReadonlySet<string>>();

function hasLiveSession(
  state: DeviceServiceState,
  threadId: ThreadId,
  target: { readonly hostId: string; readonly deviceId: string },
): boolean {
  return state.sessions.some(
    (session) =>
      session.threadId === threadId &&
      session.hostId === target.hostId &&
      session.deviceId === target.deviceId,
  );
}

/**
 * A device the agent opens floats over its thread's chat, or becomes a panel tab
 * when floating previews are off; sheet layouts get neither. A session without a
 * device summary yet stays out of the baseline so a later snapshot opens it.
 * Floating devices whose session ended close here.
 */
export function applyDeviceSnapshot(
  environmentId: EnvironmentId,
  state: DeviceServiceState,
  options: { readonly sheetLayout: boolean; readonly autoShowFloatingPreview: boolean },
): void {
  const deviceFor = (session: DeviceServiceState["sessions"][number]) =>
    state.devices.find((entry) => entry.hostId === session.hostId && entry.id === session.deviceId);

  const miniPlayer = usePreviewMiniPlayerStore.getState();
  for (const [threadKey, entry] of Object.entries(miniPlayer.byThreadKey)) {
    if (entry.source.kind !== "device") continue;
    const ref = parseScopedThreadKey(threadKey);
    if (ref?.environmentId === environmentId && !hasLiveSession(state, ref.threadId, entry.source))
      miniPlayer.close(ref);
  }

  const previous = deviceSessionBaselines.get(environmentId);
  deviceSessionBaselines.set(
    environmentId,
    new Set(state.sessions.filter((session) => deviceFor(session) !== undefined).map(sessionKey)),
  );
  if (!previous || options.sheetLayout) return;
  for (const session of state.sessions) {
    if (previous.has(sessionKey(session))) continue;
    const device = deviceFor(session);
    if (!device) continue;
    const threadRef = scopeThreadRef(environmentId, session.threadId);
    const target = {
      hostId: session.hostId,
      deviceId: session.deviceId,
      platform: device.platform,
      name: device.name,
    };
    if (options.autoShowFloatingPreview) {
      usePreviewMiniPlayerStore.getState().open(threadRef, { kind: "device", ...target });
      continue;
    }
    const existing = useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.some(
        (surface) =>
          surface.kind === "device" &&
          surface.target?.hostId === session.hostId &&
          surface.target.deviceId === session.deviceId,
      );
    if (existing) continue;
    useRightPanelStore.getState().openDevice(threadRef, target, true);
  }
}

/**
 * Floats a device panel tab over chat. A tab whose device session already
 * ended has nothing to stream, so it only closes the panel. Before the first
 * device snapshot the tab floats, and that snapshot closes it if needed.
 */
export function floatDeviceSurface(
  threadRef: ScopedThreadRef,
  source: Extract<PreviewMiniPlayerSource, { kind: "device" }>,
  state: DeviceServiceState | null,
): void {
  if (state !== null && !hasLiveSession(state, threadRef.threadId, source)) return;
  usePreviewMiniPlayerStore.getState().open(threadRef, source);
}

export function resetDeviceSessionBaselinesForTests(): void {
  deviceSessionBaselines.clear();
  printerSessionBaselines.clear();
  disconnectedPrinterSessions.clear();
  activePrinterSessionOrigins.clear();
  dismissedCanonicalPrinterSessions.clear();
}

const printerSessionBaselines = new Map<
  EnvironmentId,
  ReadonlyMap<string, PrinterServiceState["sessions"][number]>
>();
/** Retains sessions across a transient disconnect when no proxy took over, so the first reconnect snapshot can reconcile them. */
const disconnectedPrinterSessions = new Map<
  EnvironmentId,
  ReadonlyMap<string, PrinterServiceState["sessions"][number]>
>();
/** Deduplicates identical agent printer sessions across environments by canonical session identity. */
const activePrinterSessionOrigins = new Map<string, EnvironmentId>();
/** Preserves user dismissal across cross-environment canonical ownership transfers until all envs end the session. */
const dismissedCanonicalPrinterSessions = new Set<string>();

function isPrinterSurfaceDismissed(threadRef: ScopedThreadRef, surfaceId: string): boolean {
  return (
    useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.dismissedPrinterSurfaceIds?.includes(surfaceId) ??
    false
  );
}

const printerSessionKey = (session: PrinterServiceState["sessions"][number]) =>
  `${session.threadId}:${session.proxyEnvironmentId ?? ""}:${session.printerId}:${session.openedAt}`;

const canonicalPrinterSessionKey = (
  environmentId: EnvironmentId,
  session: PrinterServiceState["sessions"][number],
) => `${session.threadId}:${session.proxyEnvironmentId ?? environmentId}:${session.printerId}`;

function printerSurfaceIdForSession(
  originEnvironmentId: EnvironmentId,
  session: PrinterServiceState["sessions"][number],
): string {
  const ownerEnvironmentId = session.proxyEnvironmentId ?? originEnvironmentId;
  return ownerEnvironmentId !== originEnvironmentId
    ? `printer:${encodeURIComponent(ownerEnvironmentId)}:${encodeURIComponent(session.printerId)}`
    : `printer:${encodeURIComponent(session.printerId)}`;
}

function releaseOrTransferPrinterSessionOrigin(
  canonical: string,
  departingEnvironmentId: EnvironmentId,
  sheetLayout: boolean,
): boolean {
  if (activePrinterSessionOrigins.get(canonical) !== departingEnvironmentId) return false;
  for (const [survivingEnvId, sessions] of printerSessionBaselines) {
    if (survivingEnvId === departingEnvironmentId) continue;
    for (const session of sessions.values()) {
      if (canonicalPrinterSessionKey(survivingEnvId, session) !== canonical) continue;
      activePrinterSessionOrigins.set(canonical, survivingEnvId);
      const threadRef = scopeThreadRef(survivingEnvId, session.threadId);
      const surfaceId = printerSurfaceIdForSession(survivingEnvId, session);
      if (
        !sheetLayout &&
        !dismissedCanonicalPrinterSessions.has(canonical) &&
        !isPrinterSurfaceDismissed(threadRef, surfaceId)
      ) {
        useRightPanelStore.getState().openPrinter(
          threadRef,
          {
            printerId: session.printerId,
            ...(session.proxyEnvironmentId
              ? { proxyEnvironmentId: session.proxyEnvironmentId }
              : {}),
            ...(session.printerLabel ? { label: session.printerLabel } : {}),
          },
          true,
        );
      }
      return true;
    }
  }
  activePrinterSessionOrigins.delete(canonical);
  dismissedCanonicalPrinterSessions.delete(canonical);
  return false;
}

export function disconnectPrinterEnvironment(
  environmentId: EnvironmentId,
  options: { readonly sheetLayout: boolean },
): void {
  const departingSessions = printerSessionBaselines.get(environmentId);
  printerSessionBaselines.delete(environmentId);
  const transferredCanonicals = new Set<string>();
  const retainedOnDisconnect = new Map<string, PrinterServiceState["sessions"][number]>();

  if (departingSessions) {
    for (const session of departingSessions.values()) {
      const threadRef = scopeThreadRef(environmentId, session.threadId);
      const surfaceId = printerSurfaceIdForSession(environmentId, session);
      const canonical = canonicalPrinterSessionKey(environmentId, session);
      if (
        activePrinterSessionOrigins.get(canonical) === environmentId &&
        isPrinterSurfaceDismissed(threadRef, surfaceId)
      ) {
        dismissedCanonicalPrinterSessions.add(canonical);
      }
    }
  }

  const ownedCanonicals: string[] = [];
  for (const [canonical, origin] of activePrinterSessionOrigins) {
    if (origin === environmentId) {
      ownedCanonicals.push(canonical);
    }
  }
  for (const canonical of ownedCanonicals) {
    if (releaseOrTransferPrinterSessionOrigin(canonical, environmentId, options.sheetLayout)) {
      transferredCanonicals.add(canonical);
    }
  }

  // Close departing agent-opened tabs immediately only on handoff to a surviving environment.
  // Otherwise retain them across transient disconnects and reconcile against the first reconnect snapshot.
  if (departingSessions) {
    for (const [key, session] of departingSessions) {
      const canonical = canonicalPrinterSessionKey(environmentId, session);
      if (transferredCanonicals.has(canonical)) {
        const threadRef = scopeThreadRef(environmentId, session.threadId);
        const surfaceId = printerSurfaceIdForSession(environmentId, session);
        useRightPanelStore.getState().closePrinterSessionSurface(threadRef, surfaceId);
      } else {
        retainedOnDisconnect.set(key, session);
      }
    }
  }
  if (retainedOnDisconnect.size > 0) {
    disconnectedPrinterSessions.set(environmentId, retainedOnDisconnect);
  } else {
    disconnectedPrinterSessions.delete(environmentId);
  }
}

export function applyPrinterSnapshot(
  environmentId: EnvironmentId,
  state: PrinterServiceState,
  options: { readonly sheetLayout: boolean },
): void {
  const previous = printerSessionBaselines.get(environmentId);
  const retainedBeforeDisconnect = disconnectedPrinterSessions.get(environmentId);
  if (retainedBeforeDisconnect) {
    disconnectedPrinterSessions.delete(environmentId);
  }
  const next = new Map(state.sessions.map((session) => [printerSessionKey(session), session]));
  printerSessionBaselines.set(environmentId, next);
  if (!previous) {
    for (const session of next.values()) {
      const canonical = canonicalPrinterSessionKey(environmentId, session);
      if (!activePrinterSessionOrigins.has(canonical)) {
        activePrinterSessionOrigins.set(canonical, environmentId);
      }
    }
    if (retainedBeforeDisconnect) {
      for (const [key, retained] of retainedBeforeDisconnect) {
        const threadRef = scopeThreadRef(environmentId, retained.threadId);
        const surfaceId = printerSurfaceIdForSession(environmentId, retained);
        const canonical = canonicalPrinterSessionKey(environmentId, retained);
        const claimedByOther =
          activePrinterSessionOrigins.has(canonical) &&
          activePrinterSessionOrigins.get(canonical) !== environmentId;
        const stillActiveHere =
          !claimedByOther &&
          (next.has(key) ||
            state.sessions.some(
              (session) =>
                session.threadId === retained.threadId &&
                printerSurfaceIdForSession(environmentId, session) === surfaceId,
            ));
        if (!stillActiveHere) {
          useRightPanelStore.getState().closePrinterSessionSurface(threadRef, surfaceId);
        }
      }
    }
    return;
  }

  // Close auto-opened printer tabs whose agent session ended and clear per-session dismissal suppression.
  for (const [key, ended] of previous) {
    if (next.has(key)) continue;
    const threadRef = scopeThreadRef(environmentId, ended.threadId);
    const surfaceId = printerSurfaceIdForSession(environmentId, ended);
    const stillActiveHere = state.sessions.some(
      (session) =>
        session.threadId === ended.threadId &&
        printerSurfaceIdForSession(environmentId, session) === surfaceId,
    );
    if (!stillActiveHere) {
      const canonical = canonicalPrinterSessionKey(environmentId, ended);
      if (
        activePrinterSessionOrigins.get(canonical) === environmentId &&
        isPrinterSurfaceDismissed(threadRef, surfaceId)
      ) {
        dismissedCanonicalPrinterSessions.add(canonical);
      }
      useRightPanelStore.getState().closePrinterSessionSurface(threadRef, surfaceId);
      releaseOrTransferPrinterSessionOrigin(canonical, environmentId, options.sheetLayout);
    }
  }

  if (options.sheetLayout) return;
  for (const [key, session] of next) {
    if (previous.has(key)) continue;
    const canonical = canonicalPrinterSessionKey(environmentId, session);
    const existingOrigin = activePrinterSessionOrigins.get(canonical);
    if (existingOrigin !== undefined && existingOrigin !== environmentId) {
      continue;
    }
    activePrinterSessionOrigins.set(canonical, environmentId);
    const printer = state.printers.find((entry) => entry.id === session.printerId);
    const threadRef = scopeThreadRef(environmentId, session.threadId);
    const label = session.printerLabel ?? printer?.label;
    useRightPanelStore.getState().openPrinter(
      threadRef,
      {
        printerId: session.printerId,
        ...(session.proxyEnvironmentId ? { proxyEnvironmentId: session.proxyEnvironmentId } : {}),
        ...(label ? { label } : {}),
      },
      true,
    );
  }
}

function watchEnvironmentDevices(environmentId: EnvironmentId): () => void {
  const stopDevices = appAtomRegistry.subscribe(
    deviceEnvironment.state({ environmentId, input: {} }),
    (result) => {
      const state = AsyncResult.getOrElse(result, () => null);
      if (state === null) return;
      applyDeviceSnapshot(environmentId, state, {
        sheetLayout: window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches,
        autoShowFloatingPreview: getClientSettings().browserAutoShowFloatingPreview,
      });
    },
    { immediate: true },
  );
  const stopPrinters = appAtomRegistry.subscribe(
    printerEnvironment.state({ environmentId, input: {} }),
    (result) => {
      const state = AsyncResult.getOrElse(result, () => null);
      if (state === null) return;
      applyPrinterSnapshot(environmentId, state, {
        sheetLayout: window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches,
      });
    },
    { immediate: true },
  );
  return () => {
    stopDevices();
    stopPrinters();
    deviceSessionBaselines.delete(environmentId);
    disconnectPrinterEnvironment(environmentId, {
      sheetLayout: window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches,
    });
  };
}

/**
 * Follows every thread's browser previews and every connected environment's
 * device sessions for the life of the page, not just the open thread's: an
 * agent in a background thread can open either.
 */
export function startAgentOpenedPreviews(): () => void {
  const followed = new Map<string, () => void>();
  const followNewThreads = (refs: ReadonlyMap<string, ScopedThreadRef>) => {
    for (const [threadKey, threadRef] of refs) {
      if (!followed.has(threadKey)) followed.set(threadKey, followThread(threadKey, threadRef));
    }
  };
  const stopIndex = appAtomRegistry.subscribe(previewThreadRefsAtom, followNewThreads, {
    immediate: true,
  });
  const watchedEnvironments = new Map<EnvironmentId, () => void>();
  const watchConnectedEnvironments = (environmentIds: ReadonlyArray<EnvironmentId>) => {
    for (const [environmentId, stop] of watchedEnvironments) {
      if (environmentIds.includes(environmentId)) continue;
      stop();
      watchedEnvironments.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watchedEnvironments.has(environmentId)) {
        watchedEnvironments.set(environmentId, watchEnvironmentDevices(environmentId));
      }
    }
  };
  const stopEnvironments = appAtomRegistry.subscribe(
    environmentSummaries.connectedEnvironmentIdsAtom,
    watchConnectedEnvironments,
    { immediate: true },
  );
  return () => {
    stopIndex();
    stopEnvironments();
    for (const stop of followed.values()) stop();
    for (const stop of watchedEnvironments.values()) stop();
  };
}
