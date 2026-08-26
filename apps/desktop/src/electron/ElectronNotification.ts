import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export function shouldShowAgentTurnNotification(input: {
  readonly platform: NodeJS.Platform;
  readonly anyWindowFocused: boolean;
  readonly supported: boolean;
}): boolean {
  return input.platform === "win32" && !input.anyWindowFocused && input.supported;
}

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    readonly showAgentTurnCompleted: (input: {
      readonly threadTitle: string;
    }) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/electron/ElectronNotification") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;

  return ElectronNotification.of({
    showAgentTurnCompleted: (input) =>
      Effect.try(() => {
        const show = shouldShowAgentTurnNotification({
          platform,
          anyWindowFocused: Electron.BrowserWindow.getFocusedWindow() !== null,
          supported: Electron.Notification.isSupported(),
        });
        if (!show) {
          return false;
        }
        new Electron.Notification({
          title: "Agent finished",
          body: input.threadTitle,
          silent: true,
        }).show();
        return true;
      }).pipe(Effect.orElseSucceed(() => false)),
  });
});

export const layer = Layer.effect(ElectronNotification, make);
