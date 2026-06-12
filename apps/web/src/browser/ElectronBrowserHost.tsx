"use client";

import { parseScopedThreadKey } from "@t3tools/client-runtime";
import { useMemo } from "react";

import { isElectron } from "~/env";
import { usePreviewStateStore } from "~/previewStateStore";

import { HostedBrowserWebview } from "./HostedBrowserWebview";

export function ElectronBrowserHost() {
  const previewByThreadKey = usePreviewStateStore((state) => state.byThreadKey);
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef
          ? Object.values(previewState.sessions).map((snapshot) => ({
              threadRef,
              snapshot,
              active: previewState.activeTabId === snapshot.tabId,
            }))
          : [];
      }),
    [previewByThreadKey],
  );

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(({ threadRef, snapshot }) => {
        const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
        return (
          <HostedBrowserWebview
            key={snapshot.tabId}
            threadRef={threadRef}
            tabId={snapshot.tabId}
            initialUrl={url}
          />
        );
      })}
    </div>
  );
}
