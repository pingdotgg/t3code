import type { DeviceServiceState, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import {
  browserMiniPlayerSource,
  usePreviewMiniPlayerStore,
  type PreviewMiniPlayerState,
} from "../../previewMiniPlayerStore";
import type { ThreadPreviewState } from "../../previewStateStore";
import { useRightPanelStore, type RightPanelSurface } from "../../rightPanelStore";

const selectAutoShowFloatingPreview = (settings: { browserAutoShowFloatingPreview: boolean }) =>
  settings.browserAutoShowFloatingPreview;

/**
 * Shows browsers and devices an agent or another client opened for the thread,
 * and closes a floating device once its session ends.
 */
export function useAgentOpenedPreviews(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly deviceState: DeviceServiceState;
  readonly deviceStateLoaded: boolean;
  readonly previewState: ThreadPreviewState;
  // Whether the environment hosts browser tabs for this client.
  readonly serverBrowserAvailable: boolean;
  readonly panelSurfaces: ReadonlyArray<RightPanelSurface>;
  readonly miniPlayerSource: PreviewMiniPlayerState["source"] | null;
  // Sheet layouts show neither floating previews nor auto-opened device tabs.
  readonly sheetLayout: boolean;
}) {
  const {
    threadRef,
    deviceState,
    deviceStateLoaded,
    previewState,
    serverBrowserAvailable,
    panelSurfaces,
    miniPlayerSource,
    sheetLayout,
  } = input;
  const autoShowFloatingPreview = useClientSettings(selectAutoShowFloatingPreview);
  // A device the agent opens floats over chat like an agent-driven browser,
  // or becomes a panel tab when floating previews are off. Sessions opened by
  // another client arrive the same way; sheet layouts get neither. The first
  // snapshot is a baseline: persisted tabs restore themselves, and existing
  // sessions must not resurrect closed tabs. A session whose device summary
  // has not arrived yet stays out of the baseline so a later snapshot opens it.
  const previousDeviceSessions = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    if (!threadRef || !deviceStateLoaded) return;
    const threadKey = `${threadRef.environmentId}:${threadRef.threadId}`;
    const sessions = deviceState.sessions.filter(
      (session) => session.threadId === threadRef.threadId,
    );
    const key = (session: (typeof sessions)[number]) => `${session.hostId}:${session.deviceId}`;
    const deviceFor = (session: (typeof sessions)[number]) =>
      deviceState.devices.find(
        (entry) => entry.hostId === session.hostId && entry.id === session.deviceId,
      );
    const previous = previousDeviceSessions.current.get(threadKey);
    previousDeviceSessions.current.set(
      threadKey,
      new Set(sessions.filter((session) => deviceFor(session) !== undefined).map(key)),
    );
    if (!previous || sheetLayout) return;
    for (const session of sessions) {
      if (previous.has(key(session))) continue;
      const device = deviceFor(session);
      if (!device) continue;
      const target = {
        hostId: session.hostId,
        deviceId: session.deviceId,
        platform: device.platform,
        name: device.name,
      };
      if (autoShowFloatingPreview) {
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
  }, [
    threadRef,
    autoShowFloatingPreview,
    deviceStateLoaded,
    sheetLayout,
    deviceState.sessions,
    deviceState.devices,
  ]);
  // Baseline loaded tabs so reloads never reopen previews the user dismissed.
  const previousServerPreviewTabs = useRef(new Map<string, Map<string, string | undefined>>());
  useEffect(() => {
    if (!threadRef || !serverBrowserAvailable || !previewState.listLoaded) return;
    const threadKey = scopedThreadKey(threadRef);
    const serverSessions = Object.values(previewState.sessions).filter(
      (session) => session.runtime === "server",
    );
    const previous = previousServerPreviewTabs.current.get(threadKey);
    previousServerPreviewTabs.current.set(
      threadKey,
      new Map(serverSessions.map((session) => [session.tabId, session.revealRequest?.id])),
    );
    if (!previous) return;
    for (const session of serverSessions) {
      const requested = session.revealRequest;
      const fresh = requested
        ? previous.get(session.tabId) !== requested.id
        : !previous.has(session.tabId);
      if (!fresh || session.reveal !== true) continue;
      if (!autoShowFloatingPreview && requested?.force !== true) continue;
      const surface = panelSurfaces.find(
        (surface) => surface.kind === "preview" && surface.resourceId === session.tabId,
      );
      if (surface && requested?.force === true) {
        useRightPanelStore.getState().activateSurface(threadRef, surface.id);
      } else if (!surface) {
        usePreviewMiniPlayerStore
          .getState()
          .open(threadRef, browserMiniPlayerSource(session.tabId));
      }
    }
  }, [
    serverBrowserAvailable,
    previewState.listLoaded,
    previewState.sessions,
    threadRef,
    autoShowFloatingPreview,
    panelSurfaces,
  ]);
  // A floating device follows its session: once the agent or another client
  // closes the device there is nothing left to stream.
  useEffect(() => {
    if (!threadRef || !deviceStateLoaded) return;
    const source = miniPlayerSource;
    if (source?.kind !== "device") return;
    const sessionStillExists = deviceState.sessions.some(
      (session) =>
        session.threadId === threadRef.threadId &&
        session.hostId === source.hostId &&
        session.deviceId === source.deviceId,
    );
    if (!sessionStillExists) usePreviewMiniPlayerStore.getState().close(threadRef);
  }, [miniPlayerSource, threadRef, deviceState.sessions, deviceStateLoaded]);
}
