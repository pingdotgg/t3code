import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useEffect, useMemo } from "react";

import { useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion } from "../Sidebar.logic";

type TaskbarUnreadThread = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "environmentId" | "id" | "latestTurn"
>;

const BADGE_RENDER_SIZE = 64;
const MAX_VISIBLE_COUNT = 9;
const badgeDataUrlByLabel = new Map<string, string>();

export function getTaskbarBadgeLabel(count: number): string {
  return count > MAX_VISIBLE_COUNT ? `${MAX_VISIBLE_COUNT}+` : String(count);
}

function createTaskbarBadgeDataUrl(count: number): string | null {
  const label = getTaskbarBadgeLabel(count);
  const cached = badgeDataUrlByLabel.get(label);
  if (cached !== undefined) {
    return cached;
  }

  const canvas = document.createElement("canvas");
  canvas.width = BADGE_RENDER_SIZE;
  canvas.height = BADGE_RENDER_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) {
    return null;
  }

  context.beginPath();
  context.arc(32, 32, 24, 0, Math.PI * 2);
  context.fillStyle = "#e5484d";
  context.fill();

  context.fillStyle = "#ffffff";
  context.font = `600 ${label.length === 1 ? 34 : 25}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 32, 33);

  const dataUrl = canvas.toDataURL("image/png");
  badgeDataUrlByLabel.set(label, dataUrl);
  return dataUrl;
}

export function countUnseenTaskbarCompletions(
  threads: ReadonlyArray<TaskbarUnreadThread>,
  lastVisitedAtByThreadKey: Readonly<Record<string, string>>,
): number {
  return threads.reduce((count, thread) => {
    if (thread.archivedAt !== null) {
      return count;
    }
    const threadKey = scopedThreadKey({
      environmentId: thread.environmentId,
      threadId: thread.id,
    });
    return (
      count +
      Number(
        hasUnseenCompletion({
          latestTurn: thread.latestTurn,
          lastVisitedAt: lastVisitedAtByThreadKey[threadKey],
        }),
      )
    );
  }, 0);
}

export function DesktopTaskbarUnreadCoordinator() {
  const threads = useThreadShells();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const count = useMemo(
    () => countUnseenTaskbarCompletions(threads, lastVisitedAtByThreadKey),
    [lastVisitedAtByThreadKey, threads],
  );
  const desktopBridge = window.desktopBridge;
  const setIndicator = desktopBridge?.setTaskbarUnreadIndicator;
  const needsOverlayImage = desktopBridge?.getClientPlatform?.() === "win32";

  useEffect(() => {
    if (setIndicator === undefined) {
      return;
    }
    void setIndicator({
      count,
      badgeDataUrl: count > 0 && needsOverlayImage ? createTaskbarBadgeDataUrl(count) : null,
    }).catch(() => {});
  }, [count, needsOverlayImage, setIndicator]);

  useEffect(
    () => () => {
      void setIndicator?.({ count: 0, badgeDataUrl: null }).catch(() => {});
    },
    [setIndicator],
  );

  return null;
}
