import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import { parseDesktopThreadLink } from "./DesktopDeepLink.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

const { logWarning } = makeComponentLogger("desktop-deep-link");

export class DesktopDeepLinkRouter extends Context.Service<
  DesktopDeepLinkRouter,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopDeepLinkRouter") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const preReadyOpenUrls = yield* DesktopPreReadyPlatform.DesktopPreReadyOpenUrls;
  const context = yield* Effect.context<DesktopWindow.DesktopWindow>();
  const runPromise = Effect.runPromiseWith(context);

  const openFirstThreadLink = (values: ReadonlyArray<string>) => {
    const thread = values
      .map((value) => parseDesktopThreadLink({ isDevelopment: environment.isDevelopment, value }))
      .find((value) => value !== null);
    if (thread === undefined || thread === null) return;

    void runPromise(
      desktopWindow.openThread(thread).pipe(
        Effect.catch((error) =>
          logWarning("failed to open thread deep link", {
            message: error.message,
          }),
        ),
      ),
    );
  };

  return DesktopDeepLinkRouter.of({
    configure: Effect.gen(function* () {
      openFirstThreadLink(process.argv);
      preReadyOpenUrls.setHandler((url) => {
        openFirstThreadLink([url]);
      });
      yield* electronApp.on("second-instance", (_event, commandLine: string[]) => {
        openFirstThreadLink(commandLine);
      });
    }).pipe(Effect.withSpan("desktop.deepLink.configure")),
  });
});

export const layer = Layer.effect(DesktopDeepLinkRouter, make);
