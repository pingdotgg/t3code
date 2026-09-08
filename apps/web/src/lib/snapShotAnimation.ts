import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, SnapShotSource } from "@t3tools/contracts";

import type { DraftId } from "../composerDraftStore";
import { getDesktopSnapShotBridge } from "./desktopSnapShot";

type SnapShotTarget = DraftId | ScopedThreadRef;

export type PendingSnapShotAnimation = {
  readonly id: string;
  readonly target: SnapShotTarget;
  readonly source?: SnapShotSource | undefined;
};

let pendingAnimations: ReadonlyArray<PendingSnapShotAnimation> = [];
const destinationRequests = new Map<string, Promise<void>>();
const destinationMountCounts = new Map<string, number>();
const listeners = new Set<() => void>();
const DESTINATION_TIMEOUT_MS = 2_000;
const ARRIVAL_MAX_AGE_MS = 10_000;

export function shouldAnimateSnapShotArrival(capturedAt: string, now = Date.now()): boolean {
  const capturedTime = Date.parse(capturedAt);
  const age = now - capturedTime;
  return Number.isFinite(capturedTime) && age >= 0 && age <= ARRIVAL_MAX_AGE_MS;
}

function targetKey(target: SnapShotTarget): string {
  return typeof target === "string" ? target.trim() : scopedThreadKey(target);
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function beginSnapShotAnimation(id: string, target: SnapShotTarget): void {
  if (pendingAnimations.some((capture) => capture.id === id)) return;
  destinationRequests.delete(id);
  pendingAnimations = [{ id, target }, ...pendingAnimations];
  emitChange();
}

export function finishSnapShotAnimation(id: string): void {
  const next = pendingAnimations.filter((capture) => capture.id !== id);
  destinationRequests.delete(id);
  destinationMountCounts.delete(id);
  if (next.length === pendingAnimations.length) return;
  pendingAnimations = next;
  emitChange();
}

export function updateSnapShotAnimationSource(id: string, source: SnapShotSource): void {
  const index = pendingAnimations.findIndex((capture) => capture.id === id);
  if (index < 0 || pendingAnimations[index]?.source === source) return;
  pendingAnimations = pendingAnimations.map((capture, captureIndex) =>
    captureIndex === index ? { ...capture, source } : capture,
  );
  emitChange();
}

export async function dismissSnapShotAnimation(id: string): Promise<void> {
  if (!pendingAnimations.some((capture) => capture.id === id)) return;
  finishSnapShotAnimation(id);
  const bridge = getDesktopSnapShotBridge();
  if (typeof bridge?.dismissSnapShotAnimation !== "function") return;
  await bridge.dismissSnapShotAnimation(id).catch(() => undefined);
}

export function dismissAllSnapShotAnimations(): void {
  const ids = pendingAnimations.map((capture) => capture.id);
  if (ids.length === 0) return;
  pendingAnimations = [];
  destinationRequests.clear();
  destinationMountCounts.clear();
  emitChange();
  const bridge = getDesktopSnapShotBridge();
  if (typeof bridge?.dismissSnapShotAnimation !== "function") return;
  for (const id of ids) {
    void bridge.dismissSnapShotAnimation(id).catch(() => undefined);
  }
}

export function getPendingSnapShotAnimations(): ReadonlyArray<PendingSnapShotAnimation> {
  return pendingAnimations;
}

export function subscribeToPendingSnapShotAnimations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pendingSnapShotAnimationIdsForTarget(
  pending: ReadonlyArray<PendingSnapShotAnimation>,
  target: SnapShotTarget,
): ReadonlyArray<string> {
  const key = targetKey(target);
  return pending
    .filter((capture) => targetKey(capture.target) === key)
    .map((capture) => capture.id);
}

export function setSnapShotAnimationDestination(
  id: string,
  target: HTMLElement,
  source?: SnapShotSource,
): void {
  if (!target.isConnected || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const bridge = getDesktopSnapShotBridge();
  if (typeof bridge?.setSnapShotAnimationDestination !== "function") return;
  const frame = target.getBoundingClientRect();
  if (frame.width <= 0 || frame.height <= 0) return;
  const style = window.getComputedStyle(target);
  const cornerRadius = Number.parseFloat(style.borderTopLeftRadius);
  const borderWidth = Number.parseFloat(style.borderTopWidth);
  const request = bridge
    .setSnapShotAnimationDestination({
      id,
      viewportFrame: {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
      },
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      borderWidth: Number.isFinite(borderWidth) ? borderWidth : 0,
      cornerRadius: Number.isFinite(cornerRadius) ? cornerRadius : 0,
      ...(source
        ? {
            details: {
              appName: source.appName,
              windowTitle: source.windowTitle,
              ...(source.appIconDataUrl ? { appIconDataUrl: source.appIconDataUrl } : {}),
            },
          }
        : {}),
    })
    .catch(() => undefined);
  destinationRequests.set(id, request);
}

export async function waitForSnapShotAnimationDestination(id: string): Promise<void> {
  const request = destinationRequests.get(id);
  if (!request) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      request,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, DESTINATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function scheduleSnapShotAnimationDestination(id: string, start: () => void): () => void {
  let active = true;
  destinationMountCounts.set(id, (destinationMountCounts.get(id) ?? 0) + 1);
  queueMicrotask(() => {
    if (!active) return;
    start();
  });
  return () => {
    if (!active) return;
    active = false;
    const remainingMounts = Math.max(0, (destinationMountCounts.get(id) ?? 1) - 1);
    if (remainingMounts === 0) destinationMountCounts.delete(id);
    else destinationMountCounts.set(id, remainingMounts);
    queueMicrotask(() => {
      if ((destinationMountCounts.get(id) ?? 0) > 0) return;
      if (!pendingAnimations.some((capture) => capture.id === id)) return;
      void dismissSnapShotAnimation(id);
    });
  };
}
