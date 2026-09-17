import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

/** Host segment of a pairing deep link: `t3code://pair?host=...&label=...#token=...`. */
export const PAIRING_LINK_HOST = "pair";

/**
 * Pick the pairing deep link out of a list of candidate strings (an argv, or a
 * single URL from macOS `open-url`). Only links on this build's own scheme with
 * the `pair` host count; the renderer parses host/label/token from it.
 */
export function extractPairingLink(
  candidates: ReadonlyArray<string>,
  scheme: string,
): string | null {
  const prefix = `${scheme}:`;
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.toLowerCase().startsWith(prefix)) continue;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue;
    }
    if (url.protocol.toLowerCase() !== prefix || url.host !== PAIRING_LINK_HOST) continue;
    return url.toString();
  }
  return null;
}

export class DesktopPairingLink extends Context.Service<
  DesktopPairingLink,
  {
    /**
     * Start listening for pairing deep links. Registers before `ready` so a
     * macOS `open-url` delivered at cold start is not missed.
     */
    readonly register: Effect.Effect<void, never, Scope.Scope>;
    /**
     * The renderer signals when its coordinator is mounted; a link that
     * arrived earlier (cold start) is delivered then.
     */
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopPairingLink") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-pairing-link");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);

  const pendingRef = yield* Ref.make(Option.none<string>());
  const rendererReadyRef = yield* Ref.make(false);

  const deliver = Effect.fn("desktop.pairingLink.deliver")(function* (link: string) {
    yield* logInfo("delivering pairing link to renderer");
    yield* desktopWindow.dispatchPairingLink(link);
  });

  // Reveal the window right away so the click feels acknowledged, but hold
  // the link until the renderer says it can act on it.
  const receive = Effect.fn("desktop.pairingLink.receive")(function* (link: string) {
    yield* Ref.set(pendingRef, Option.some(link));
    if (yield* Ref.get(rendererReadyRef)) {
      yield* Ref.set(pendingRef, Option.none());
      yield* deliver(link);
      return;
    }
    yield* logInfo("holding pairing link until renderer is ready");
    yield* desktopWindow.activate;
  });

  const receiveFromCandidates = (candidates: ReadonlyArray<string>) => {
    const link = extractPairingLink(candidates, scheme);
    if (link === null) return;
    void runPromise(
      receive(link).pipe(
        Effect.catchCause((cause) => logWarning("failed to handle pairing link", { cause })),
      ),
    );
  };

  const register = Effect.gen(function* () {
    // macOS hands URLs to the running (or launching) app via open-url. The
    // Clerk bridge also listens here but only claims its own renderer origin.
    yield* electronApp.on<[Electron.Event, string]>("open-url", (_event, url) => {
      receiveFromCandidates([url]);
    });
    // Windows and Linux launch a second process with the URL in argv; the
    // primary instance receives that argv here.
    yield* electronApp.on<[Electron.Event, ReadonlyArray<string>, string]>(
      "second-instance",
      (_event, argv) => {
        receiveFromCandidates(argv);
      },
    );
    // Cold start on Windows/Linux: the URL is in this process's own argv.
    receiveFromCandidates(process.argv);
  }).pipe(Effect.withSpan("desktop.pairingLink.register"));

  const setRendererReady = Effect.fn("desktop.pairingLink.setRendererReady")(function* (
    ready: boolean,
  ) {
    yield* Ref.set(rendererReadyRef, ready);
    if (!ready) return;
    const pending = yield* Ref.getAndSet(pendingRef, Option.none());
    if (Option.isSome(pending)) {
      yield* deliver(pending.value).pipe(
        Effect.catchCause((cause) => logWarning("failed to deliver pairing link", { cause })),
      );
    }
  });

  return DesktopPairingLink.of({ register, setRendererReady });
});

export const layer = Layer.effect(DesktopPairingLink, make);
