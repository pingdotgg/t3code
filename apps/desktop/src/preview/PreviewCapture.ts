import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const captureLocks = new WeakMap<Electron.WebContents, Semaphore.Semaphore>();

// Chromium rasterizes CSS-scaled guests at their displayed size, even for capturePage.
// Freeze only that preview while capturing unscaled pixels; never change its viewport.
export const capturePreviewPage = (
  tabId: string,
  wc: Electron.WebContents,
  rect?: Electron.Rectangle,
) => {
  let lock = captureLocks.get(wc);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    captureLocks.set(wc, lock);
  }
  const capture = Effect.tryPromise((_signal) => wc.capturePage(rect));
  return lock.withPermit(
    Effect.gen(function* () {
      const host = wc.hostWebContents;
      if (!host || host.isDestroyed()) return yield* capture;
      const scaled = yield* Effect.tryPromise((_signal) =>
        host.executeJavaScript(`(() => {
          const view = document.querySelector("webview[data-preview-tab=" + CSS.escape(${encodeString(tabId)}) + "]");
          return !!view && getComputedStyle(view).transform !== "none";
        })()`),
      );
      if (scaled !== true) return yield* capture;
      const frozen = yield* Effect.tryPromise((_signal) => wc.capturePage());
      const token = `preview-capture-${NodeCrypto.randomUUID()}`;
      return yield* Effect.tryPromise((_signal) =>
        host.executeJavaScript(`(async () => {
            const view = document.querySelector("webview[data-preview-tab=" + CSS.escape(${encodeString(tabId)}) + "]");
            if (!view || view.getWebContentsId() !== ${wc.id}) throw new Error("Preview guest detached before capture");
            const frozen = document.createElement("img");
            frozen.src = ${encodeString(frozen.toDataURL())};
            frozen.alt = "";
            frozen.className = view.className;
            frozen.style.cssText = view.style.cssText;
            frozen.style.pointerEvents = "none";
            frozen.style.maxWidth = "none";
            const holder = document.createElement("span");
            holder.id = ${encodeString(token)};
            holder.style.display = "contents";
            const style = document.createElement("style");
            style.textContent = 'webview[data-preview-tab="' + CSS.escape(view.dataset.previewTab) + '"] { transform: none !important; opacity: 0 !important; pointer-events: none !important; }';
            holder.append(frozen);
            view.after(holder);
            await frozen.decode();
            if (holder.isConnected && view.isConnected) holder.append(style);
          })()`),
      ).pipe(
        Effect.andThen(
          Effect.tryPromise((_signal) =>
            host.executeJavaScript(
              "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
            ),
          ),
        ),
        Effect.andThen(capture),
        Effect.ensuring(
          Effect.suspend(() =>
            host.isDestroyed()
              ? Effect.void
              : Effect.tryPromise((_signal) =>
                  host.executeJavaScript(
                    `document.getElementById(${encodeString(token)})?.remove()`,
                  ),
                ).pipe(Effect.timeout("1 second"), Effect.ignore),
          ),
        ),
      );
    }),
  );
};
