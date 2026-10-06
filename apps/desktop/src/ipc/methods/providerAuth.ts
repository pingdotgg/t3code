import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  receiveCodexAuthCallback,
  cancelCodexAuthCallback,
  CodexAuthCallbackError,
} from "../../app/CodexAuthCallback.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const Request = Schema.String.check(Schema.isMaxLength(16_384));

export const receiveProviderAuthCallback = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECEIVE_PROVIDER_AUTH_CALLBACK_CHANNEL,
  payload: Request,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.providerAuth.receive")(function* (authorizationUrl) {
    const shell = yield* ElectronShell.ElectronShell;
    const windows = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<ElectronShell.ElectronShell>();
    const runPromise = Effect.runPromiseWith(context);
    const callbackUrl = yield* Effect.tryPromise({
      try: () =>
        receiveCodexAuthCallback(authorizationUrl, (url) => runPromise(shell.openExternal(url))),
      catch: () =>
        new CodexAuthCallbackError({
          detail:
            "Could not receive ChatGPT sign-in on this computer. Try again or paste the redirect URL.",
        }),
    });
    const window = yield* windows.currentMainOrFirst;
    if (Option.isSome(window)) yield* windows.reveal(window.value);
    return callbackUrl;
  }),
});

export const cancelProviderAuthCallback = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CANCEL_PROVIDER_AUTH_CALLBACK_CHANNEL,
  payload: Request,
  result: Schema.Void,
  handler: (authorizationUrl) =>
    Effect.try({
      try: () => cancelCodexAuthCallback(authorizationUrl),
      catch: () => new CodexAuthCallbackError({ detail: "Invalid ChatGPT sign-in request." }),
    }),
});
