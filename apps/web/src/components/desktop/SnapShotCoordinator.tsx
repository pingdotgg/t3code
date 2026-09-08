import {
  type DesktopPendingSnapShot,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

import {
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import { readThreadShell } from "../../state/entities";
import { compressImageToByteLimit, dataUrlToFile } from "../../lib/imageCompression";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import {
  beginSnapShotAnimation,
  dismissAllSnapShotAnimations,
  dismissSnapShotAnimation,
  finishSnapShotAnimation,
  getPendingSnapShotAnimations,
  updateSnapShotAnimationSource,
  waitForSnapShotAnimationDestination,
} from "../../lib/snapShotAnimation";
import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { playSnapShotSound } from "../../lib/snapShotSound";
import {
  dispatchSnapShotComposerFocus,
  getDesktopSnapShotBridge,
  type DesktopSnapShotBridge,
} from "../../lib/desktopSnapShot";
import { readFileAsDataUrl } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

type CaptureTarget = DraftId | ScopedThreadRef;

export function resolveExistingSnapShotTarget(
  target: CaptureTarget,
  routeThreadRef: ScopedThreadRef | null,
): CaptureTarget | null {
  const store = useComposerDraftStore.getState();
  if (typeof target === "string") {
    const draftSession = store.getDraftSession(target);
    if (draftSession?.promotedTo) return draftSession.promotedTo;
    return draftSession ? target : null;
  }
  const targetIsCurrentRoute =
    routeThreadRef !== null &&
    routeThreadRef.environmentId === target.environmentId &&
    routeThreadRef.threadId === target.threadId;
  return targetIsCurrentRoute ||
    store.getDraftSessionByRef(target) !== null ||
    readThreadShell(target) !== null
    ? target
    : null;
}

const NEXT_PAINT_FALLBACK_MS = 100;

export async function beginSnapShotAnimationWhenReady(
  id: string,
  target: Promise<CaptureTarget | null>,
  pendingStarts: Set<string>,
): Promise<void> {
  pendingStarts.add(id);
  try {
    const resolvedTarget = await target;
    if (pendingStarts.delete(id) && resolvedTarget) {
      beginSnapShotAnimation(id, resolvedTarget);
    }
  } finally {
    pendingStarts.delete(id);
  }
}

export function dismissFailedSnapShot(
  id: string | undefined,
  soundedIds: Set<string>,
  pendingStarts: Set<string>,
): void {
  if (id) {
    pendingStarts.delete(id);
    soundedIds.delete(id);
    void dismissSnapShotAnimation(id);
  } else {
    pendingStarts.clear();
    soundedIds.clear();
    dismissAllSnapShotAnimations();
  }
}

export function resolveSnapShotTargetOnce(
  resolutionRef: { current: Promise<CaptureTarget | null> | null },
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  if (resolutionRef.current) return resolutionRef.current;
  const resolution = resolveTarget().finally(() => {
    if (resolutionRef.current === resolution) resolutionRef.current = null;
  });
  resolutionRef.current = resolution;
  return resolution;
}

// A capture keeps its destination even after its animation unmounts or the window blurs.
export function resolveSnapShotDeliveryTarget(
  targets: Map<string, Promise<CaptureTarget | null>>,
  id: string,
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  const existing = targets.get(id);
  if (existing) return existing;
  const target = resolveTarget().catch(() => null);
  targets.set(id, target);
  void target.then((resolved) => {
    if (!resolved && targets.get(id) === target) targets.delete(id);
  });
  return target;
}

async function afterNextPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    const fallback = window.setTimeout(resolve, NEXT_PAINT_FALLBACK_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        resolve();
      });
    });
  });
}

export async function deliverSnapShot(
  bridge: DesktopSnapShotBridge,
  item: DesktopPendingSnapShot,
  target: CaptureTarget,
): Promise<void> {
  const store = useComposerDraftStore.getState();
  updateSnapShotAnimationSource(item.id, item.source);
  const capture = await bridge.readSnapShot(item.id);
  const original = dataUrlToFile(capture.dataUrl, capture.name, capture.mimeType);
  const compressed = await compressImageToByteLimit(original, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!compressed.ok) {
    finishSnapShotAnimation(item.id);
    throw new Error("The captured window is too large to attach.");
  }
  const file = compressed.file;
  const source = resizeSnapShotSource(capture.source, compressed.imageSize);
  const dataUrl = compressed.recompressed ? await readFileAsDataUrl(file) : capture.dataUrl;
  const alreadyAttached =
    store.getComposerDraft(target)?.images.some(({ id }) => id === capture.id) ?? false;
  if (
    !alreadyAttached &&
    !store.addImage(target, {
      type: "image",
      id: capture.id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: dataUrl,
      file,
      source,
    })
  ) {
    throw new Error("Remove an attachment, then try this capture again.");
  }
  const persisted: PersistedComposerImageAttachment = {
    id: capture.id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    dataUrl,
    source,
  };
  const persistedAttachments =
    store
      .getComposerDraft(target)
      ?.persistedAttachments.filter((attachment) => attachment.id !== capture.id) ?? [];
  await store.syncPersistedAttachments(target, [...persistedAttachments, persisted]);
  if (!store.getComposerDraft(target)?.persistedAttachments.some(({ id }) => id === capture.id)) {
    throw new Error("The captured window could not be saved to the draft.");
  }

  // Reveal the attachment under the flying capture before the desktop tears the overlay down,
  // otherwise the tile is missing for the frames between the landing and its first paint.
  if (getPendingSnapShotAnimations().some((animation) => animation.id === capture.id)) {
    await afterNextPaint();
    await waitForSnapShotAnimationDestination(capture.id).catch(() => undefined);
    finishSnapShotAnimation(capture.id);
    await afterNextPaint();
  }
  await bridge.acknowledgeSnapShot(capture.id);
  dispatchSnapShotComposerFocus();
}

export function SnapShotCoordinator() {
  const {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  } = useHandleNewThread();
  const captureSound = useClientSettings((settings) =>
    settings.snapShotPlaySound ? settings.snapShotSound : null,
  );
  const animateCaptures = useClientSettings((settings) => settings.snapShotAnimations);
  const captureTargetsRef = useRef(new Map<string, Promise<CaptureTarget | null>>());
  const lastTargetRef = useRef<CaptureTarget | null>(null);
  const targetResolutionRef = useRef<Promise<CaptureTarget | null> | null>(null);
  const drainingRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);
  const soundedCaptureIdsRef = useRef(new Set<string>());
  const pendingAnimationStartsRef = useRef(new Set<string>());

  const currentTarget = routeThreadRef ?? routeDraftId;
  if (currentTarget) lastTargetRef.current = currentTarget;

  const resolveTarget = useCallback(async (): Promise<CaptureTarget | null> => {
    const lastTarget = lastTargetRef.current;
    if (lastTarget) {
      const existingTarget = resolveExistingSnapShotTarget(lastTarget, routeThreadRef);
      if (existingTarget) {
        lastTargetRef.current = existingTarget;
        return existingTarget;
      }
      lastTargetRef.current = null;
    }
    const projectRef = resolveThreadActionProjectRef({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
    if (!projectRef) return null;
    const created = await handleNewThread(projectRef);
    if (!created) return null;
    lastTargetRef.current = created.draftId;
    return created.draftId;
  }, [activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef]);

  const resolveCaptureTarget = useCallback(
    () => resolveSnapShotTargetOnce(targetResolutionRef, resolveTarget),
    [resolveTarget],
  );

  const playCaptureSound = useCallback(
    (id: string) => {
      if (!captureSound || soundedCaptureIdsRef.current.has(id)) return;
      soundedCaptureIdsRef.current.add(id);
      try {
        playSnapShotSound(captureSound);
      } catch {}
    },
    [captureSound],
  );

  const drain = useCallback(async () => {
    const bridge = getDesktopSnapShotBridge();
    if (!bridge) return;
    if (drainingRef.current) {
      rerunRequestedRef.current = true;
      return drainingRef.current;
    }

    const operation = (async () => {
      do {
        rerunRequestedRef.current = false;
        const pending = await bridge.listPendingSnapShots();
        for (const item of pending) {
          playCaptureSound(item.id);
          const capturedTarget = await resolveSnapShotDeliveryTarget(
            captureTargetsRef.current,
            item.id,
            resolveCaptureTarget,
          );
          const target = capturedTarget
            ? resolveExistingSnapShotTarget(capturedTarget, routeThreadRef)
            : null;
          if (!target) {
            await dismissSnapShotAnimation(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Snapshot taken, but no project is available",
                description: "Add a project, then capture the window again.",
              }),
            );
            continue;
          }

          try {
            await deliverSnapShot(bridge, item, target);
            captureTargetsRef.current.delete(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
          } catch (error) {
            await dismissSnapShotAnimation(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Snapshot failed",
                description: `Capture ${item.id}: ${
                  error instanceof Error ? error.message : "Try the capture again."
                }`,
              }),
            );
          }
        }
      } while (rerunRequestedRef.current);
    })()
      .catch((error: unknown) => {
        dismissAllSnapShotAnimations();
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Snapshot failed",
            description: error instanceof Error ? error.message : "Try the capture again.",
          }),
        );
      })
      .finally(() => {
        drainingRef.current = null;
      });
    drainingRef.current = operation;
    return operation;
  }, [playCaptureSound, resolveCaptureTarget, routeThreadRef]);

  useEffect(() => {
    const bridge = getDesktopSnapShotBridge();
    if (!bridge) return;
    void drain();
    const unsubscribe = bridge.onSnapShotEvent((event) => {
      switch (event.type) {
        case "requested": {
          const current = lastTargetRef.current;
          const target = current ? resolveExistingSnapShotTarget(current, routeThreadRef) : null;
          // Creating a new draft would navigate the renderer before a self-capture finishes.
          // Pin existing drafts now; create a destination after acquisition when none exists.
          if (target) {
            void resolveSnapShotDeliveryTarget(captureTargetsRef.current, event.id, () =>
              Promise.resolve(target),
            );
          }
          return;
        }
        case "started": {
          playCaptureSound(event.id);
          if (animateCaptures && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            void beginSnapShotAnimationWhenReady(
              event.id,
              resolveSnapShotDeliveryTarget(
                captureTargetsRef.current,
                event.id,
                resolveCaptureTarget,
              ),
              pendingAnimationStartsRef.current,
            );
          }
          return;
        }
        case "ready":
          void drain();
          return;
        case "failed": {
          if (event.id) captureTargetsRef.current.delete(event.id);
          dismissFailedSnapShot(
            event.id,
            soundedCaptureIdsRef.current,
            pendingAnimationStartsRef.current,
          );
          void bridge.getSnapShotState().then((state) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Snapshot failed",
                description: state.message ?? "Try the capture again.",
              }),
            );
          });
          return;
        }
        case "shortcut-changed":
          return;
      }
    });
    return unsubscribe;
  }, [animateCaptures, drain, playCaptureSound, resolveCaptureTarget, routeThreadRef]);

  useEffect(() => {
    const dismissOnBlur = () => {
      pendingAnimationStartsRef.current.clear();
      dismissAllSnapShotAnimations();
    };
    const drainOnFocus = () => void drain();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") dismissOnBlur();
      else void drain();
    };
    window.addEventListener("blur", dismissOnBlur);
    window.addEventListener("focus", drainOnFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", dismissOnBlur);
      window.removeEventListener("focus", drainOnFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [drain]);

  return null;
}
