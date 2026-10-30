import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
let captureSequence = 0;
const captureLocks = new WeakMap<Electron.WebContents, Semaphore.Semaphore>();

export const resetPreviewCapture = (wc: Electron.WebContents) => captureLocks.delete(wc);

// Chromium rasterizes CSS-scaled guests at their displayed size, including CDP screenshots.
// Freeze only that preview while capturing unscaled pixels; never change its viewport.
export const withUnscaledPreviewCapture = Effect.fn("PreviewCapture.withUnscaledPreviewCapture")(<
  A,
  E,
  R,
>(
  tabId: string,
  wc: Electron.WebContents,
  capture: Effect.Effect<A, E, R>,
  tabAttribute: "data-preview-tab" | "data-preview-server-tab" = "data-preview-tab",
  unscaledCaptureTimeoutMs?: number,
  current: () => boolean = () => true,
) => {
  const requireCurrent = Effect.try(() => {
    if (!current()) throw new Error("The page this screenshot was for has moved on.");
  });
  let lock = captureLocks.get(wc);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    captureLocks.set(wc, lock);
  }
  // A pending native relay capture must keep its queue slot to prevent overlapping Chromium copies.
  const nativeCapture =
    unscaledCaptureTimeoutMs === undefined ? Effect.uninterruptible : Effect.interruptible;
  const unscaledCapture =
    unscaledCaptureTimeoutMs === undefined
      ? nativeCapture(capture)
      : capture.pipe(Effect.timeout(unscaledCaptureTimeoutMs));
  return lock
    .withPermit(
      Effect.gen(function* () {
        const host = wc.hostWebContents;
        if (!host || host.isDestroyed()) return yield* unscaledCapture;
        const scaled = yield* Effect.tryPromise((_signal) =>
          host.executeJavaScript(`(() => {
          // Hidden hosts suspend animation frames, so overlay setup cannot finish.
          if (document.visibilityState !== "visible") return false;
          const view = document.querySelector("webview[${tabAttribute}=" + CSS.escape(${encodeString(tabId)}) + "]");
          return !!view && view.getWebContentsId() === ${wc.id} && getComputedStyle(view).transform !== "none";
        })()`),
        ).pipe(
          Effect.timeout("250 millis"),
          Effect.orElseSucceed(() => false),
        );
        if (scaled !== true) return yield* unscaledCapture;
        yield* requireCurrent;
        const frozen = yield* nativeCapture(Effect.tryPromise((_signal) => wc.capturePage()));
        yield* requireCurrent;
        const token = `preview-capture-${++captureSequence}`;
        // The renderer checks delayed IPC expiry outside the Effect runtime.
        const deadline = (yield* Clock.Clock.defaultValue().currentTimeMillis) + 5_000;
        return yield* Effect.tryPromise((_signal) =>
          host.executeJavaScript(`(async () => {
            const token = ${encodeString(token)};
            if (globalThis[token] || Date.now() >= ${deadline}) throw new Error("Preview capture expired");
            const view = document.querySelector("webview[${tabAttribute}=" + CSS.escape(${encodeString(tabId)}) + "]");
            if (!view || view.getWebContentsId() !== ${wc.id}) throw new Error("Preview guest detached before capture");
            const frozen = document.createElement("img");
            frozen.src = ${encodeString(frozen.toDataURL())};
            frozen.alt = "";
            frozen.className = view.className;
            frozen.style.cssText = view.style.cssText;
            frozen.style.pointerEvents = "none";
            frozen.style.maxWidth = "none";
            const holder = document.createElement("span");
            holder.id = token;
            holder.style.display = "contents";
            const style = document.createElement("style");
            const selector = 'webview[data-preview-capture="' + token + '"]';
            // Keep Chromium rendering the guest; zero opacity can stall CDP screenshots.
            style.textContent = selector + ' { transform: none !important; opacity: 0.001 !important; pointer-events: none !important; } #' + token + ' { display: none !important; } ' + selector + ' + #' + token + ' { display: contents !important; }';
            let active = true;
            const cleanup = () => {
              active = false;
              holder.remove();
              if (view.dataset.previewCapture === token) delete view.dataset.previewCapture;
            };
            globalThis[token] = cleanup;
            // Recover without main-process IPC, including a decode that settles after cancellation.
            setTimeout(() => {
              cleanup();
              delete globalThis[token];
            }, Math.max(0, ${deadline} - Date.now()));
            view.dataset.previewCapture = token;
            holder.append(frozen);
            view.after(holder);
            await frozen.decode();
            if (!active || !holder.isConnected || !view.isConnected || view.getWebContentsId() !== ${wc.id}) {
              cleanup();
              throw new Error("Preview guest detached during capture");
            }
            holder.append(style);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (!active) throw new Error("Preview capture expired");
          })()`),
        ).pipe(
          Effect.andThen(nativeCapture(capture)),
          Effect.ensuring(
            Effect.suspend(() =>
              host.isDestroyed()
                ? Effect.void
                : Effect.tryPromise((_signal) =>
                    host.executeJavaScript(
                      `(() => {
                        const token = ${encodeString(token)};
                        if (globalThis[token]) globalThis[token]();
                        else {
                          // Cancel setup even if its IPC arrives after this cleanup.
                          globalThis[token] = () => {};
                          setTimeout(() => { delete globalThis[token]; }, 5_000);
                        }
                      })()`,
                    ),
                  ).pipe(Effect.retry({ times: 1 }), Effect.timeout("1 second"), Effect.ignore),
            ),
          ),
        );
      }),
    )
    .pipe(
      // Bound setup and queueing; native relay copies retain their queue slot until settled.
      Effect.timeout("5 seconds"),
    );
});

export const capturePreviewPage = (tabId: string, wc: Electron.WebContents) =>
  withUnscaledPreviewCapture(
    tabId,
    wc,
    Effect.tryPromise((_signal) => wc.capturePage()),
    "data-preview-tab",
    1_000,
  );
