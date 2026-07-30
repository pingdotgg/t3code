import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import { getDesktopScheme } from "../electron/ElectronProtocol.ts";
import {
  describeDeepLinkTarget,
  findDeepLinkTarget,
  parseDeepLinkTarget,
} from "./deepLinkTarget.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

export { describeDeepLinkTarget, findDeepLinkTarget, parseDeepLinkTarget };

const { logInfo: logDeepLinkInfo } = makeComponentLogger("desktop-deep-links");

export class DesktopDeepLinks extends Context.Service<
  DesktopDeepLinks,
  {
    // Claims the scheme and starts listening. Runs before the app is ready so a
    // cold-start link in argv is captured before anything can overwrite it.
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    // Hands the pending link to the renderer that asks for it, clearing it in
    // the same step. The renderer pulls on mount because a cold-start link is
    // captured long before any renderer exists to be pushed to.
    readonly takePending: Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/app/DesktopDeepLinks") {}

export const make = (processArgv: ReadonlyArray<string> = process.argv) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronApp = yield* ElectronApp.ElectronApp;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;

    const scheme = getDesktopScheme(environment.isDevelopment);
    // One slot rather than a queue: these are navigation requests, so replaying
    // a backlog would only flash through intermediate routes to land on the
    // newest one anyway. The latest link wins.
    const pendingTargetRef = yield* Ref.make(Option.none<string>());

    const takePending = Ref.getAndSet(pendingTargetRef, Option.none<string>()).pipe(
      Effect.withSpan("desktop.deepLinks.takePending"),
    );

    // Tries the renderer immediately for links that arrive while the app runs.
    // Anything that cannot be handed over right now stays pending for the next
    // renderer to pull, so nothing is dropped on the way.
    const deliverPending = Effect.gen(function* () {
      const pendingTarget = yield* Ref.get(pendingTargetRef);
      if (Option.isNone(pendingTarget)) {
        return;
      }

      const delivered = yield* desktopWindow
        .dispatchDeepLink(pendingTarget.value)
        .pipe(Effect.orElseSucceed(() => false));
      if (delivered) {
        // Compare before clearing: a newer link may have replaced this one
        // while the send was in flight.
        yield* Ref.update(pendingTargetRef, (current) =>
          Option.isSome(current) && current.value === pendingTarget.value ? Option.none() : current,
        );
      }
    }).pipe(Effect.withSpan("desktop.deepLinks.deliverPending"));

    const captureTarget = Effect.fn("desktop.deepLinks.captureTarget")(function* (
      target: Option.Option<string>,
    ) {
      if (Option.isNone(target)) {
        return;
      }

      // A link is external input that can carry a token in its query or
      // fragment, so only the route shape is logged.
      yield* logDeepLinkInfo("deep link received", describeDeepLinkTarget(target.value));
      yield* Ref.set(pendingTargetRef, target);
      yield* deliverPending;
    });

    const captureUrl = (rawUrl: unknown) => captureTarget(parseDeepLinkTarget(rawUrl, scheme));

    const configure = Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(context);

      // macOS routes links through the app object; Linux and Windows append them
      // to argv, so those two need an explicit registration to be asked at all.
      // NSIS never writes the association, so this is the only thing that
      // registers the scheme on Windows.
      if (environment.platform !== "darwin") {
        yield* environment.isPackaged
          ? electronApp.setAsDefaultProtocolClient(scheme)
          : // An unpackaged run is `electron <entry>`, so the association has to
            // point at the Electron binary and repeat the entry argument for the
            // relaunched process to load anything.
            electronApp.setAsDefaultProtocolClient(scheme, process.execPath, [environment.appPath]);
      }

      yield* electronApp.on("open-url", (...args: ReadonlyArray<unknown>) => {
        const [event, url] = args as [{ preventDefault?: () => void } | undefined, unknown];
        event?.preventDefault?.();
        void runPromise(captureUrl(url));
      });

      yield* electronApp.on("second-instance", (...args: ReadonlyArray<unknown>) => {
        const [, argv] = args as [unknown, ReadonlyArray<string> | undefined];
        void runPromise(captureTarget(findDeepLinkTarget(argv ?? [], scheme)));
      });

      yield* Ref.set(pendingTargetRef, findDeepLinkTarget(processArgv, scheme));
    }).pipe(Effect.withSpan("desktop.deepLinks.configure"));

    return DesktopDeepLinks.of({ configure, takePending });
  });

export const layer = Layer.effect(DesktopDeepLinks, make());
