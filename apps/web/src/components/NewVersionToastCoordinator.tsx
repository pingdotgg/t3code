"use client";

import { useEffect, useRef } from "react";
import { useDesktopUpdateState } from "../lib/desktopUpdateReactQuery";
import { toastManager } from "./ui/toast";
import {
  acknowledgeCurrentVersion,
  getNewVersionReleaseNotesUrl,
  shouldShowNewVersionToast,
} from "./desktopUpdate.logic";

export function NewVersionToastCoordinator() {
  const { data: updateState } = useDesktopUpdateState();
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (!shouldShowNewVersionToast(updateState)) return;

    const version = updateState!.currentVersion;
    acknowledgeCurrentVersion(updateState);

    if (toastIdRef.current) {
      toastManager.close(toastIdRef.current);
    }

    toastIdRef.current = toastManager.add({
      type: "success",
      title: `Updated to v${version}`,
      description: "View what's new in this release",
      timeout: 0,
      actionProps: {
        children: "View release notes",
        onClick: async () => {
          const bridge = window.desktopBridge;
          const url = getNewVersionReleaseNotesUrl(version);
          if (bridge?.openExternal) {
            await bridge.openExternal(url);
          } else {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        },
      },
    });
  }, [updateState]);

  useEffect(() => {
    return () => {
      if (toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
    };
  }, []);

  return null;
}
