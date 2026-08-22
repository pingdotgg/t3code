import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  DESKTOP_THREAD_DEEP_LINK_SCHEME,
  findThreadDeepLinkInArgv,
  parseThreadDeepLinkUrl,
} from "../deeplink/threadDeepLink.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import type { DesktopWindowError } from "../window/DesktopWindow.ts";

type DesktopDeepLinkRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp;

/**
 * @effect-expect-leaking DesktopEnvironment | DesktopWindow | ElectronApp
 */
export class DesktopDeepLinks extends Context.Service<
  DesktopDeepLinks,
  {
    readonly registerEarly: Effect.Effect<
      void,
      never,
      Scope.Scope | DesktopDeepLinkRuntimeServices
    >;
    readonly configure: Effect.Effect<void, never, DesktopDeepLinkRuntimeServices>;
  }
>()("@t3tools/desktop/app/DesktopDeepLinks") {}

const { logInfo: logDeepLinkInfo, logError: logDeepLinkError } =
  makeComponentLogger("desktop-deeplink");

export const make = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopDeepLinkRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const openThreadDeepLink = (threadId: string) =>
    Effect.gen(function* () {
      yield* logDeepLinkInfo("open thread deep link", { threadId });
      yield* desktopWindow
        .openThread(threadId)
        .pipe(
          Effect.catch((error: DesktopWindowError) =>
            logDeepLinkError("failed to open thread deep link", { threadId, error }),
          ),
        );
    }).pipe(Effect.withSpan("desktop.deeplink.openThread"));

  const handleDeepLinkUrl = (rawUrl: string) =>
    Effect.gen(function* () {
      const threadId = parseThreadDeepLinkUrl(rawUrl);
      if (Option.isNone(threadId)) {
        return;
      }
      yield* openThreadDeepLink(threadId.value);
    }).pipe(Effect.withSpan("desktop.deeplink.handleUrl"));

  return DesktopDeepLinks.of({
    registerEarly: Effect.gen(function* () {
      yield* electronApp.on("open-url", (event: Electron.Event, url: string) => {
        event.preventDefault();
        void runPromise(handleDeepLinkUrl(url));
      });

      yield* electronApp.on(
        "second-instance",
        (_event: Electron.Event, argv: readonly string[]) => {
          const launchUrl = findThreadDeepLinkInArgv(argv);
          if (Option.isSome(launchUrl)) {
            void runPromise(openThreadDeepLink(launchUrl.value));
          }
        },
      );
    }).pipe(Effect.withSpan("desktop.deeplink.registerEarly")),

    configure: Effect.gen(function* () {
      // Pin registration to this executable on macOS so Launch Services routes
      // `t3://` links to the running channel (Alpha/Nightly) instead of whichever
      // app happens to share the production bundle id.
      const registered = yield* environment.platform === "darwin"
        ? electronApp.setAsDefaultProtocolClient(
            DESKTOP_THREAD_DEEP_LINK_SCHEME,
            process.execPath,
            [],
          )
        : electronApp.setAsDefaultProtocolClient(DESKTOP_THREAD_DEEP_LINK_SCHEME);
      if (!registered) {
        yield* logDeepLinkError("failed to register default protocol client", {
          scheme: DESKTOP_THREAD_DEEP_LINK_SCHEME,
        });
      }

      const launchThreadId = findThreadDeepLinkInArgv(process.argv);
      if (Option.isSome(launchThreadId)) {
        yield* openThreadDeepLink(launchThreadId.value);
      }
    }).pipe(Effect.withSpan("desktop.deeplink.configure")),
  });
});

export const layer = Layer.effect(DesktopDeepLinks, make);
