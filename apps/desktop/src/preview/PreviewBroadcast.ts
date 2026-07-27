import { BrowserWindow } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Fan-out of preview main-process events to every renderer window.
 *
 * The desktop shell owns window lifetime, so the preview slice only needs a
 * narrow broadcast capability rather than a full window service.
 */
export class PreviewBroadcast extends Context.Service<
  PreviewBroadcast,
  {
    readonly sendAll: (channel: string, ...args: readonly unknown[]) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/preview/PreviewBroadcast") {}

export const make = (listWindows: () => readonly BrowserWindow[]): PreviewBroadcast["Service"] =>
  PreviewBroadcast.of({
    sendAll: (channel, ...args) =>
      Effect.sync(() => {
        for (const window of listWindows()) {
          if (window.isDestroyed()) {
            continue;
          }
          window.webContents.send(channel, ...args);
        }
      }),
  });

export const layer = Layer.succeed(
  PreviewBroadcast,
  make(() => BrowserWindow.getAllWindows()),
);
