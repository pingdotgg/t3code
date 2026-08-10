import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopDeepLink from "./DesktopDeepLink.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Delivers `t3code://` links to the renderer.
//
// The two platforms hand the URL over differently:
//   * macOS emits `open-url` — the URL never appears in argv.
//   * Windows/Linux pass it as a command-line argument, both on first launch
//     and, for an already-running app, via `second-instance`.
//
// Both paths funnel into the same DesktopWindow.dispatchDeepLink, which owns
// window creation, the wait for the first renderer load, and the hold-until-
// backend-ready behaviour.

const { logInfo } = makeComponentLogger("desktop-deep-link-router");

export class DesktopDeepLinkRouter extends Context.Service<
  DesktopDeepLinkRouter,
  {
    readonly register: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopDeepLinkRouter") {}

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopWindow.DesktopWindow>();
  const runPromise = Effect.runPromiseWith(context);

  const schemes = [ElectronProtocol.getDesktopScheme(environment.isDevelopment)];

  const handle = (rawUrl: string, source: "open-url" | "second-instance" | "launch-argv") => {
    const target = DesktopDeepLink.parseDeepLink(rawUrl, schemes);
    if (target === null) {
      // Not ours to act on: OAuth callbacks and the renderer bundle URL also
      // use this scheme, and they are handled elsewhere.
      return;
    }
    void runPromise(
      Effect.gen(function* () {
        yield* logInfo("received deep link", { source, kind: target.kind });
        yield* desktopWindow.dispatchDeepLink(target);
      }).pipe(
        // A malformed link must never take down the app.
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to dispatch deep link", { source, cause }),
        ),
      ),
    );
  };

  const register = Effect.gen(function* () {
    // Typed structurally so this module keeps talking to Electron only through
    // the ElectronApp service, as the rest of the app does.
    yield* electronApp.on<[{ preventDefault: () => void }, string]>(
      "open-url",
      (event, url) => {
        event.preventDefault();
        handle(url, "open-url");
      },
    );

    // A second `second-instance` listener alongside the one that reveals the
    // window: Electron invokes every registered listener, so window reveal and
    // link routing stay owned by their respective modules.
    yield* electronApp.on<[unknown, readonly string[], string]>(
      "second-instance",
      (_event, argv) => {
        const url = DesktopDeepLink.findDeepLinkInArgv(argv ?? [], schemes);
        if (url !== null) handle(url, "second-instance");
      },
    );

    // Windows/Linux cold start: the link that launched the app is already in
    // our own argv, and no event will ever be emitted for it.
    const launchUrl = DesktopDeepLink.findDeepLinkInArgv(process.argv, schemes);
    if (launchUrl !== null) {
      handle(launchUrl, "launch-argv");
    }
  }).pipe(Effect.withSpan("desktop.deepLinkRouter.register"));

  return DesktopDeepLinkRouter.of({ register });
});

export const layer = Layer.effect(DesktopDeepLinkRouter, make);
