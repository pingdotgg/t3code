import type { DeviceServiceState, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import {
  usePreviewMiniPlayerStore,
  type PreviewMiniPlayerState,
} from "../../previewMiniPlayerStore";
import { useRightPanelStore } from "../../rightPanelStore";

const selectAutoShowFloatingPreview = (settings: { browserAutoShowFloatingPreview: boolean }) =>
  settings.browserAutoShowFloatingPreview;

export function useAgentOpenedPreviews(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly deviceState: DeviceServiceState;
  readonly deviceStateLoaded: boolean;
  readonly miniPlayerSource: PreviewMiniPlayerState["source"] | null;
  // Sheet layouts show neither floating previews nor auto-opened device tabs.
  readonly sheetLayout: boolean;
}) {
  const { threadRef, deviceState, deviceStateLoaded, miniPlayerSource, sheetLayout } = input;
  const autoShowFloatingPreview = useClientSettings(selectAutoShowFloatingPreview);
  // Baseline sessions to preserve dismissals on reload; missing device summaries must remain eligible to open
  // later.
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
