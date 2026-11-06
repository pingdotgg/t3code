import {
  type DesktopBridge,
  type DesktopPendingSnapShot,
  type DesktopSnapShotEvent,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useStableCallback } from "../../hooks/useStableCallback";
import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { readThreadShell } from "../../state/entities";
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
import { dispatchSnapShotComposerFocus, getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import {
  countQuestionRequestAttachments,
  openQuestionAttachmentDraft,
} from "../../questionAttachments";
import { stackedThreadToast, toastManager } from "../ui/toast";

type CaptureTarget = DraftId | ScopedThreadRef;
type CaptureFailure = "missing-project" | "delivery";

function isSameCaptureTarget(a: CaptureTarget, b: CaptureTarget): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

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

// Pin absence too: a later question must never claim an earlier capture.
export function resolveSnapShotAttachmentTarget(
  pins: Map<string, DraftId | null>,
  id: string,
  target: CaptureTarget,
): CaptureTarget {
  const open = typeof target === "string" ? null : openQuestionAttachmentDraft(target);
  if (!pins.has(id)) pins.set(id, open?.draftId ?? null);
  const pinned = pins.get(id);
  return pinned && pinned === open?.draftId ? pinned : target;
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

function resolveSnapShotTargetOnce(
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
  bridge: DesktopBridge,
  item: DesktopPendingSnapShot,
  resolveTarget: () => CaptureTarget,
): Promise<void> {
  const store = useComposerDraftStore.getState();
  updateSnapShotAnimationSource(item.id, item.source);
  const capture = await bridge.readSnapShot(item.id);
  const { compressImageToByteLimit, dataUrlToFile, readFileAsDataUrl } =
    await import("../../lib/imageCompression");
  const original = dataUrlToFile(capture.dataUrl, capture.name, capture.mimeType);
  const compressed = await compressImageToByteLimit(original, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!compressed.ok) {
    finishSnapShotAnimation(item.id);
    throw new Error("The captured window is too large to attach.");
  }
  const file = compressed.file;
  const source = resizeSnapShotSource(capture.source, compressed.imageSize);
  const dataUrl = compressed.recompressed ? await readFileAsDataUrl(file) : capture.dataUrl;
  const target = resolveTarget();
  const alreadyAttached =
    store.getComposerDraft(target)?.images.some(({ id }) => id === capture.id) ?? false;
  if (!alreadyAttached) {
    const questionAttachmentCount =
      typeof target === "string" ? countQuestionRequestAttachments(target) : null;
    const image = {
      type: "image" as const,
      id: capture.id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: dataUrl,
      file,
      source,
    };
    // Only question drafts may bypass addImage's thread-session gate.
    const added =
      questionAttachmentCount === null
        ? store.addImage(target, image)
        : questionAttachmentCount < PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
          store.addImages(target, [image]).includes(capture.id);
    if (!added) throw new Error("Remove an attachment, then try this capture again.");
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

  // Paint the attachment before removing the capture overlay to avoid missing frames at landing.
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
  const enabled = useClientSettings((settings) => settings.snapShotEnabled);
  const captureTargetsRef = useRef(new Map<string, Promise<CaptureTarget | null>>());
  const questionPinsRef = useRef(new Map<string, DraftId | null>());
  const targetResolutionRef = useRef<Promise<CaptureTarget | null> | null>(null);
  const drainingRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);
  const soundedCaptureIdsRef = useRef(new Set<string>());
  const reportedCaptureFailuresRef = useRef(new Map<string, Set<CaptureFailure>>());
  const pendingAnimationStartsRef = useRef(new Set<string>());

  // Captures go to the last thread or draft on screen, even from routes that show neither.
  const currentTarget = routeThreadRef ?? routeDraftId;
  const [lastRouteTarget, setLastRouteTarget] = useState(currentTarget);
  if (
    currentTarget &&
    (lastRouteTarget === null || !isSameCaptureTarget(currentTarget, lastRouteTarget))
  ) {
    setLastRouteTarget(currentTarget);
  }
  // Reuse the resolved target until navigation so captures in one drain share a draft.
  const settledTargetRef = useRef<{
    readonly routeTarget: CaptureTarget | null;
    readonly target: CaptureTarget | null;
  } | null>(null);
  const readLastRouteTarget = useStableCallback(() => lastRouteTarget);
  // Scope pending resolutions to their starting route so navigation cannot inherit another route's draft.
  const readSettledTarget = (routeTarget: CaptureTarget | null) => {
    const settled = settledTargetRef.current;
    return settled && settled.routeTarget === routeTarget ? settled.target : routeTarget;
  };
  const settleTarget = (routeTarget: CaptureTarget | null, target: CaptureTarget | null) => {
    settledTargetRef.current = { routeTarget, target };
  };

  const resolveTarget = async (): Promise<CaptureTarget | null> => {
    const routeTarget = readLastRouteTarget();
    const lastTarget = readSettledTarget(routeTarget);
    if (lastTarget) {
      const existingTarget = resolveExistingSnapShotTarget(lastTarget, routeThreadRef);
      if (existingTarget) {
        settleTarget(routeTarget, existingTarget);
        return existingTarget;
      }
      settleTarget(routeTarget, null);
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
    settleTarget(routeTarget, created.draftId);
    return created.draftId;
  };

  const resolveCaptureTarget = () => resolveSnapShotTargetOnce(targetResolutionRef, resolveTarget);

  const playCaptureSound = (id: string) => {
    if (!captureSound || soundedCaptureIdsRef.current.has(id)) return;
    soundedCaptureIdsRef.current.add(id);
    try {
      playSnapShotSound(captureSound);
    } catch {}
  };

  const reportOnce = (
    id: string,
    failure: CaptureFailure,
    toast: Parameters<typeof toastManager.add>[0],
  ) => {
    if (!getClientSettings().snapShotEnabled) return;
    const failures = reportedCaptureFailuresRef.current.get(id) ?? new Set<CaptureFailure>();
    if (failures.has(failure)) return;
    failures.add(failure);
    reportedCaptureFailuresRef.current.set(id, failures);
    toastManager.add(toast);
  };

  const drain = async () => {
    if (!getClientSettings().snapShotEnabled) return;
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
          if (!getClientSettings().snapShotEnabled) return;
          playCaptureSound(item.id);
          const capturedTarget = await resolveSnapShotDeliveryTarget(
            captureTargetsRef.current,
            item.id,
            resolveCaptureTarget,
          );
          if (!getClientSettings().snapShotEnabled) return;
          const target = capturedTarget
            ? resolveExistingSnapShotTarget(capturedTarget, routeThreadRef)
            : null;
          if (!target) {
            await dismissSnapShotAnimation(item.id);
            reportOnce(
              item.id,
              "missing-project",
              stackedThreadToast({
                type: "error",
                title: "Snapshot taken, but no project is available",
                description: "Add a project, then capture the window again.",
              }),
            );
            continue;
          }

          try {
            // Pending captures may have arrived without a requested event; pin before reading.
            resolveSnapShotAttachmentTarget(questionPinsRef.current, item.id, target);
            await deliverSnapShot(bridge, item, () =>
              resolveSnapShotAttachmentTarget(questionPinsRef.current, item.id, target),
            );
            captureTargetsRef.current.delete(item.id);
            questionPinsRef.current.delete(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
            reportedCaptureFailuresRef.current.delete(item.id);
          } catch (error) {
            await dismissSnapShotAnimation(item.id);
            reportOnce(
              item.id,
              "delivery",
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
      } while (rerunRequestedRef.current && getClientSettings().snapShotEnabled);
    })()
      .catch((error: unknown) => {
        dismissAllSnapShotAnimations();
        if (!getClientSettings().snapShotEnabled) return;
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
  };

  const drainPending = useEffectEvent(() => drain());
  const handleSnapShotEvent = useEffectEvent(
    (bridge: DesktopBridge, event: DesktopSnapShotEvent) => {
      if (!getClientSettings().snapShotEnabled) return;
      switch (event.type) {
        case "requested": {
          const current = readSettledTarget(readLastRouteTarget());
          const target = current ? resolveExistingSnapShotTarget(current, routeThreadRef) : null;
          // Creating a new draft would navigate the renderer before a self-capture finishes.
          if (target) {
            resolveSnapShotAttachmentTarget(questionPinsRef.current, event.id, target);
            void resolveSnapShotDeliveryTarget(captureTargetsRef.current, event.id, () =>
              Promise.resolve(target),
            );
          } else if (!questionPinsRef.current.has(event.id)) {
            questionPinsRef.current.set(event.id, null);
          }
          return;
        }
        case "started": {
          playCaptureSound(event.id);
          const target = resolveSnapShotDeliveryTarget(
            captureTargetsRef.current,
            event.id,
            resolveCaptureTarget,
          ).then(
            (target) =>
              target && resolveSnapShotAttachmentTarget(questionPinsRef.current, event.id, target),
          );
          if (animateCaptures && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            void beginSnapShotAnimationWhenReady(
              event.id,
              target,
              pendingAnimationStartsRef.current,
            );
          }
          return;
        }
        case "ready":
          void drain();
          return;
        case "failed": {
          if (event.id) {
            captureTargetsRef.current.delete(event.id);
            questionPinsRef.current.delete(event.id);
          }
          dismissFailedSnapShot(
            event.id,
            soundedCaptureIdsRef.current,
            pendingAnimationStartsRef.current,
          );
          void bridge.getSnapShotState().then((state) => {
            if (!getClientSettings().snapShotEnabled) return;
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
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to SnapShot events from the desktop bridge and drains pending ones while enabled
  useEffect(() => {
    const bridge = getDesktopSnapShotBridge();
    if (!bridge || !enabled) return;
    void drainPending();
    return bridge.onSnapShotEvent((event) => handleSnapShotEvent(bridge, event));
  }, [enabled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches window blur, focus and visibilitychange listeners to dismiss or drain SnapShot animations
  useEffect(() => {
    const dismissOnBlur = () => {
      pendingAnimationStartsRef.current.clear();
      dismissAllSnapShotAnimations();
    };
    const drainOnFocus = () => void drainPending();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") dismissOnBlur();
      else void drainPending();
    };
    window.addEventListener("blur", dismissOnBlur);
    window.addEventListener("focus", drainOnFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", dismissOnBlur);
      window.removeEventListener("focus", drainOnFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return null;
}
