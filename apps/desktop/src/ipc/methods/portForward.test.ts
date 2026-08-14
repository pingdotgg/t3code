import {
  DesktopPortForwardId,
  EnvironmentId,
  type DesktopPortForwardAuthorizationRequest,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import { sendPortForwardAuthorizationRequest } from "./portForward.ts";

it.effect("sends port-forward authorization only to the main renderer", () => {
  const send = vi.fn();
  const sendAll = vi.fn(() => Effect.void);
  const mainWindow = { webContents: { send } } as unknown as Electron.BrowserWindow;
  const electronWindow = ElectronWindow.ElectronWindow.of({
    currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
    sendAll,
  } as unknown as ElectronWindow.ElectronWindow["Service"]);
  const request: DesktopPortForwardAuthorizationRequest = {
    requestId: "request-1",
    forwardId: DesktopPortForwardId.make("forward-1"),
    environmentId: EnvironmentId.make("environment-1"),
    remoteHost: "127.0.0.1",
    remotePort: 5174,
  };

  return sendPortForwardAuthorizationRequest(electronWindow, request).pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(send).toHaveBeenCalledWith(
          IpcChannels.PORT_FORWARD_AUTHORIZATION_REQUEST_CHANNEL,
          request,
        );
        expect(sendAll).not.toHaveBeenCalled();
      }),
    ),
  );
});
