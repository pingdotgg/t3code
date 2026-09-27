// @effect-diagnostics globalTimers:off - the native prompt has a bounded WebAuthn timeout and is cancelled on page teardown.
import type { BrowserWindow, WebContents } from "electron";
import { loadNativePasskeys, type NativePasskeys } from "./NativePasskeys.ts";
import { normalizePasskeyRequest } from "./PasskeyRequest.ts";

export const PASSKEY_AVAILABLE = "preview:passkey-available";
export const PASSKEY_REQUEST = "preview:passkey-request";
export const PASSKEY_CANCEL = "preview:passkey-cancel";

// macOS presents one credential sheet at a time, including across preview profiles.
let busy = false;
/** Only attach to preview guests and their OAuth popups; the app's own Clerk bridge is independent. */
export function installPreviewPasskeys(
  contents: WebContents,
  owner: BrowserWindow,
  paths: readonly string[],
  load: () => Promise<NativePasskeys | undefined> = () => loadNativePasskeys(paths),
) {
  let pending: { id: string; controller: AbortController } | undefined;
  const cancel = () => pending?.controller.abort();
  contents.on("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isSameDocument) cancel();
  });
  contents.on("destroyed", cancel);
  contents.on("render-process-gone", cancel);
  contents.ipc.handle(PASSKEY_AVAILABLE, async () => {
    try {
      return (await load())?.available() ?? false;
    } catch {
      return false;
    }
  });
  contents.ipc.on(PASSKEY_CANCEL, (event, id: unknown) => {
    if (event.senderFrame === contents.mainFrame && id === pending?.id) cancel();
  });
  contents.ipc.handle(
    PASSKEY_REQUEST,
    async (event, id: unknown, operation: unknown, input: unknown) => {
      const frame = event.senderFrame;
      if (!frame || frame !== contents.mainFrame || !contents.isFocused() || owner.isDestroyed()) {
        return { error: "NotAllowedError" };
      }
      if (typeof id !== "string" || id.length > 64 || JSON.stringify(input)?.length > 64_000)
        return { error: "TypeError" };
      if (busy) return { error: "NotAllowedError" };
      const url = frame.url;
      const controller = new AbortController();
      pending = { id, controller };
      busy = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const options = normalizePasskeyRequest(operation, input, new URL(url).origin);
        const native = await load();
        if (controller.signal.aborted || frame.detached || frame.url !== url)
          return { error: "AbortError" };
        if (!contents.isFocused() || owner.isDestroyed()) return { error: "NotAllowedError" };
        if (!native?.available()) return null;
        timer = setTimeout(() => controller.abort(), options.timeout);
        const result = await native.start(
          options,
          owner.getNativeWindowHandle(),
          controller.signal,
        );
        return controller.signal.aborted || frame.detached || frame.url !== url
          ? { error: "AbortError" }
          : result;
      } catch (error) {
        return { error: error instanceof DOMException ? error.name : "TypeError" };
      } finally {
        clearTimeout(timer);
        pending = undefined;
        busy = false;
      }
    },
  );
}
