import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import { DESKTOP_HOST, getDesktopScheme } from "../electron/ElectronProtocol.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logInfo: logDeepLinkInfo } = makeComponentLogger("desktop-deep-links");

export class DesktopDeepLinks extends Context.Service<
  DesktopDeepLinks,
  {
    // Claims the scheme and starts listening. Runs before the app is ready so a
    // cold-start link in argv is captured before anything can overwrite it.
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    // Hands over a link captured before a renderer existed. Safe to call when
    // nothing is pending.
    readonly deliverPending: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopDeepLinks") {}

/**
 * Extracts the in-app target from a deep link.
 *
 * A link is untrusted input from any web page, so this only ever yields a path
 * within the renderer's own origin: a foreign scheme, a foreign host, or a
 * protocol-relative path (which a router would read as another origin) all
 * resolve to none rather than reaching the renderer.
 */
export function parseDeepLinkTarget(rawUrl: unknown, scheme: string): Option.Option<string> {
  if (typeof rawUrl !== "string") return Option.none();
  const trimmedUrl = rawUrl.trim();
  if (trimmedUrl.length === 0) return Option.none();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    return Option.none();
  }

  if (parsedUrl.protocol !== `${scheme}:` || parsedUrl.host !== DESKTOP_HOST) {
    return Option.none();
  }

  const target = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  if (!target.startsWith("/") || target.startsWith("//")) {
    return Option.none();
  }

  return Option.some(target);
}

/**
 * Finds the deep link among process arguments.
 *
 * Linux and Windows deliver links as an argv entry rather than an event, mixed
 * in with Chromium's own switches, so every argument gets tried and the first
 * one addressing our scheme wins.
 */
export function findDeepLinkTarget(
  argv: ReadonlyArray<string>,
  scheme: string,
): Option.Option<string> {
  for (const argument of argv) {
    const target = parseDeepLinkTarget(argument, scheme);
    if (Option.isSome(target)) {
      return target;
    }
  }

  return Option.none();
}

export const make = (processArgv: ReadonlyArray<string> = process.argv) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronApp = yield* ElectronApp.ElectronApp;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;

    const scheme = getDesktopScheme(environment.isDevelopment);
    const pendingTargetRef = yield* Ref.make(Option.none<string>());

    // Keeps the link until a renderer takes it. A cold-start link arrives long
    // before the window exists, and dropping it would strand the user on whatever
    // route the app opens by default.
    const deliverPending = Effect.gen(function* () {
      const pendingTarget = yield* Ref.get(pendingTargetRef);
      if (Option.isNone(pendingTarget)) {
        return;
      }

      const delivered = yield* desktopWindow
        .dispatchDeepLink(pendingTarget.value)
        .pipe(Effect.orElseSucceed(() => false));
      if (delivered) {
        yield* Ref.set(pendingTargetRef, Option.none());
      }
    }).pipe(Effect.withSpan("desktop.deepLinks.deliverPending"));

    const captureTarget = Effect.fn("desktop.deepLinks.captureTarget")(function* (
      target: Option.Option<string>,
    ) {
      if (Option.isNone(target)) {
        return;
      }

      yield* logDeepLinkInfo("deep link received", { target: target.value });
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

    return DesktopDeepLinks.of({ configure, deliverPending });
  });

export const layer = Layer.effect(DesktopDeepLinks, make());
