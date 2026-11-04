import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DESKTOP_HOST, getDesktopScheme } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import type { DesktopIpcSenderEvent } from "./DesktopIpc.ts";

export class DesktopIpcUntrustedSenderError extends Schema.TaggedError<DesktopIpcUntrustedSenderError>()(
  "DesktopIpcUntrustedSenderError",
  {},
) {
  override get message(): string {
    return "This desktop action requires the app's main renderer.";
  }
}

export const requireMainRenderer = Effect.fn("desktop.ipc.requireMainRenderer")(function* (
  event: DesktopIpcSenderEvent | undefined,
) {
  const windows = yield* ElectronWindow.ElectronWindow;
  const window = yield* windows.main;
  if (
    Option.isNone(window) ||
    !event?.senderFrame ||
    event.sender?.id !== window.value.webContents.id ||
    event.senderFrame !== window.value.webContents.mainFrame
  ) {
    return yield* new DesktopIpcUntrustedSenderError();
  }
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const url = URL.parse(event.senderFrame.url);
  // Custom-scheme origins serialize as "null", including unrelated hosts and schemes.
  if (
    url?.protocol !== `${getDesktopScheme(environment.isDevelopment)}:` ||
    url.host !== DESKTOP_HOST
  ) {
    return yield* new DesktopIpcUntrustedSenderError();
  }
});
