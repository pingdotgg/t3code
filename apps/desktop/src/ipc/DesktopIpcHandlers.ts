import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";
import * as PreviewIpc from "./methods/preview.ts";

/**
 * Installs the collaborative browser preview IPC surface.
 *
 * The desktop shell keeps ownership of every other IPC channel; only the
 * preview slice runs through the Effect IPC runtime so the preview manager can
 * own webview lifetime, automation, and artifact handling.
 */
export const installPreviewIpcHandlers = Effect.fn("desktop.ipc.installPreviewHandlers")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    yield* PreviewIpc.installPreviewEventForwarding();

    for (const previewMethod of PreviewIpc.methods) {
      yield* ipc.handle(previewMethod);
    }
  },
);
