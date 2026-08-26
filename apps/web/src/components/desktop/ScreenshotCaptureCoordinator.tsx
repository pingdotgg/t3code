import type {
  DesktopScreenshotHotkeyEvent,
  DesktopScreenshotWindowBounds,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useComposerHandleContext } from "../../composerHandleContext";
import { onComposerReady } from "../../composerReadyBus";
import {
  buildScreenshotFileName,
  resolveScreenshotNavigationTarget,
  SCREENSHOT_FLIGHT_DURATION_MS,
} from "../../lib/screenshotCapture.logic";
import { COMPOSER_IMAGE_CHIP_SURFACE_CLASS_NAME } from "../composerInlineChip";
import { readThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { ToastInlineLink, toastManager } from "../ui/toast";

const COMPOSER_WAIT_TIMEOUT_MS = 5_000;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function showScreenshotCaptureErrorToast(reason: "permission-denied" | "capture-failed"): void {
  if (reason === "permission-denied") {
    toastManager.add({
      type: "error",
      title: "Screen Recording permission needed",
      description: (
        <>
          Grant T3 Code the Screen Recording permission to capture screenshots.
          <ToastInlineLink
            onClick={() => {
              void (async () => {
                try {
                  if (await window.desktopBridge?.openScreenRecordingSettings?.()) return;
                } catch {
                  // Surface rejected IPC calls through the same fallback.
                }
                toastManager.add({ type: "error", title: "Unable to open System Settings" });
              })();
            }}
          >
            Open System Settings
          </ToastInlineLink>
        </>
      ),
    });
    return;
  }
  toastManager.add({
    type: "error",
    title: "Screenshot capture failed",
    description: "Couldn't capture the frontmost window.",
  });
}

// Decoded by hand rather than via `fetch(dataUrl)`: the desktop renderer's
// CSP connect-src does not allow data: URLs.
function screenshotFile(event: Extract<DesktopScreenshotHotkeyEvent, { type: "captured" }>): File {
  const base64 = event.dataUrl.slice(event.dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], buildScreenshotFileName(event.appName, new Date()), {
    type: "image/png",
  });
}

/**
 * Renderer half of the macOS double-⌘ screenshot hotkey. Receives captures
 * pushed by the desktop main process, attaches them to the composer of the
 * current (or most recently visited) thread, and plays the capture flash +
 * thumbnail drop-in. Renders nothing and keeps no React state — a capture
 * must not re-render the app.
 */
export function ScreenshotCaptureCoordinator() {
  const navigate = useNavigate();
  const composerHandleRef = useComposerHandleContext();

  // DOM nodes, animations, timers, and listeners created by the capture in
  // flight; disposed on unmount and superseded by the next capture.
  const cleanupsRef = useRef(new Set<() => void>());
  const generationRef = useRef(0);

  useEffect(() => {
    const subscribe = window.desktopBridge?.onScreenshotHotkey;
    if (typeof subscribe !== "function") return;

    const cleanups = cleanupsRef.current;
    const track = (cleanup: () => void) => {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
        cleanup();
      };
    };
    const disposeAll = () => {
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    };

    // The chip already exists (attach-first); the overlay is pure chrome, so
    // an interrupted flight can never lose the attachment or hide the chip.
    const playThumbnailFlight = (
      imageId: string,
      windowBounds: DesktopScreenshotWindowBounds | undefined,
    ) => {
      if (prefersReducedMotion()) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const chip = document.querySelector<HTMLElement>(
            `[data-composer-image-id="${CSS.escape(imageId)}"]`,
          );
          if (!chip || typeof chip.animate !== "function") return;
          const source = chip.querySelector("img")?.getAttribute("src");
          if (!source) return;
          const rect = chip.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return;
          // FLIP: overlay sits at the chip rect and animates from a "capture
          // card" pose down onto it. The pose starts over the captured
          // window itself — its global bounds share the window.screenX/Y
          // coordinate space, so projecting into the viewport is a subtraction
          // — falling back to a centered pose when bounds are unavailable.
          let dx: number;
          let dy: number;
          let startScale: number;
          if (windowBounds) {
            const sourceCenterX = windowBounds.x + windowBounds.width / 2 - window.screenX;
            const sourceCenterY = windowBounds.y + windowBounds.height / 2 - window.screenY;
            dx = sourceCenterX - (rect.left + rect.width / 2);
            dy = sourceCenterY - (rect.top + rect.height / 2);
            // The card is a square crop of the shot; sizing it to the captured
            // window's smaller edge (capped so a huge window stays a card)
            // reads as that window shrinking into the chip.
            startScale = Math.max(
              2,
              Math.min(Math.min(windowBounds.width, windowBounds.height) / rect.width, 10),
            );
          } else {
            dx = window.innerWidth / 2 - (rect.left + rect.width / 2);
            dy = window.innerHeight * 0.38 - (rect.top + rect.height / 2);
            startScale = 3;
          }
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

          const overlay = document.createElement("div");
          overlay.className = `${COMPOSER_IMAGE_CHIP_SURFACE_CLASS_NAME} shadow-xl`;
          overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:120;pointer-events:none;will-change:transform;`;
          const thumbnail = document.createElement("img");
          thumbnail.src = source;
          thumbnail.alt = "";
          thumbnail.className = "h-full w-full object-cover";
          overlay.appendChild(thumbnail);
          document.body.appendChild(overlay);

          const sourcePose = `translate3d(${dx}px, ${dy}px, 0) scale(${startScale})`;
          const flight = overlay.animate(
            [
              // Fade in at the source, dwell so the
              // capture registers, spring onto the chip, fade out on it.
              { offset: 0, opacity: 0, transform: sourcePose, easing: "ease-out" },
              { offset: 0.12, opacity: 1, transform: sourcePose, easing: "linear" },
              {
                offset: 0.32,
                opacity: 1,
                transform: sourcePose,
                easing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
              },
              {
                offset: 0.9,
                opacity: 1,
                transform: "translate3d(0, 0, 0) scale(1)",
                easing: "linear",
              },
              { offset: 1, opacity: 0, transform: "translate3d(0, 0, 0) scale(1)" },
            ],
            { duration: SCREENSHOT_FLIGHT_DURATION_MS },
          );
          // Default fill "none": cancel/finish always reverts the chip to its
          // natural opacity, so it can never get stuck hidden.
          const reveal = chip.animate(
            [{ opacity: 0 }, { opacity: 0, offset: 0.85 }, { opacity: 1, offset: 1 }],
            { duration: SCREENSHOT_FLIGHT_DURATION_MS, easing: "linear" },
          );
          const remove = track(() => {
            flight.cancel();
            reveal.cancel();
            overlay.remove();
          });
          flight.finished.catch(() => {}).finally(remove);
          const timer = setTimeout(remove, SCREENSHOT_FLIGHT_DURATION_MS + 1_000);
          cleanups.add(() => clearTimeout(timer));
        });
      });
    };

    const waitForComposer = () =>
      new Promise<boolean>((resolve) => {
        if (composerHandleRef?.current) {
          resolve(true);
          return;
        }
        let settle: ((ready: boolean) => void) | null = (ready: boolean) => {
          settle = null;
          remove();
          resolve(ready);
        };
        const unsubscribe = onComposerReady(() => settle?.(true));
        const timer = setTimeout(() => settle?.(false), COMPOSER_WAIT_TIMEOUT_MS);
        // The cleanup settles the promise too: a superseded capture's
        // handleCaptured must resolve (its generation check then bails), not
        // stay suspended holding the decoded screenshot forever.
        const remove = track(() => {
          unsubscribe();
          clearTimeout(timer);
          settle?.(false);
        });
      });

    const handleCaptured = async (
      event: Extract<DesktopScreenshotHotkeyEvent, { type: "captured" }>,
    ) => {
      const generation = ++generationRef.current;
      // A new capture supersedes the previous one's visuals and waits; its
      // attachment (if it got that far) already landed and stays. The capture
      // flash itself is native — the helper shows it over the captured window.
      disposeAll();
      const file = screenshotFile(event);

      if (!composerHandleRef?.current) {
        const target = resolveScreenshotNavigationTarget(
          readThreadShells(),
          useUiStateStore.getState().threadLastVisitedAtById,
        );
        if (target) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(target),
          });
        } else {
          // The index route drops into a draft for the most recent project
          // (or the no-projects hero, where the wait below times out).
          await navigate({ to: "/" });
        }
        if (generation !== generationRef.current) return;
        const ready = await waitForComposer();
        if (generation !== generationRef.current) return;
        if (!ready) {
          toastManager.add({ type: "error", title: "Couldn't attach the screenshot" });
          return;
        }
      }

      const handle = composerHandleRef?.current;
      if (!handle) {
        toastManager.add({ type: "error", title: "Couldn't attach the screenshot" });
        return;
      }
      const ids = await handle.addCapturedFiles([file]);
      if (generation !== generationRef.current) return;
      // An empty result means the composer refused the file (attachment cap,
      // plan questions pending); its own error surface already explains why.
      const imageId = ids[0];
      if (imageId !== undefined) playThumbnailFlight(imageId, event.windowBounds);
    };

    const unsubscribe = subscribe((event) => {
      if (event.type === "error") {
        showScreenshotCaptureErrorToast(event.reason);
        return;
      }
      void handleCaptured(event).catch(() => {
        toastManager.add({ type: "error", title: "Couldn't attach the screenshot" });
      });
    });

    return () => {
      unsubscribe();
      disposeAll();
    };
  }, [navigate, composerHandleRef]);

  return null;
}
