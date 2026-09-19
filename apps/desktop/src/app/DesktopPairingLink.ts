import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

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

/**
 * macOS delivers a cold-start URL through `open-url` moments after launch,
 * before async startup reaches `DesktopPairingLink.register`. This listener is
 * installed with the synchronous pre-ready setup and holds URLs until the
 * service subscribes.
 */
export class DesktopOpenUrls extends Context.Service<
  DesktopOpenUrls,
  {
    readonly subscribe: (listener: (url: string) => void) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopPairingLink/DesktopOpenUrls") {}

export const layerOpenUrls = Layer.effect(
  DesktopOpenUrls,
  Effect.sync(() => {
    const buffered: Array<string> = [];
    let subscriber: ((url: string) => void) | null = null;
    Electron.app.on("open-url", (_event, url) => {
      if (subscriber === null) {
        buffered.push(url);
        return;
      }
      subscriber(url);
    });
    return DesktopOpenUrls.of({
      subscribe: (listener) =>
        Effect.sync(() => {
          subscriber = listener;
          for (const url of buffered.splice(0)) listener(url);
        }),
    });
  }),
);

export class DesktopPairingLink extends Context.Service<
  DesktopPairingLink,
  {
    /** Start collecting pairing deep links from the OS. */
    readonly register: Effect.Effect<void, never, Scope.Scope>;
    /**
     * Hand every queued link to the renderer, oldest first. Links only leave
     * the queue this way, so a renderer that is reloading or not yet mounted
     * cannot lose one; it drains the queue when its coordinator mounts.
     */
    readonly takePending: Effect.Effect<ReadonlyArray<string>>;
  }
>()("@t3tools/desktop/app/DesktopPairingLink") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-pairing-link");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const openUrls = yield* DesktopOpenUrls;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);

  const queueRef = yield* Ref.make<ReadonlyArray<string>>([]);

  // Queue first, then nudge. A running renderer pulls on the nudge; one that
  // is still loading pulls when it mounts and finds the link waiting.
  const receive = Effect.fn("desktop.pairingLink.receive")(function* (link: string) {
    yield* Ref.update(queueRef, (queue) => [...queue, link]);
    yield* logInfo("queued pairing link");
    yield* desktopWindow.dispatchPairingLinkAvailable;
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
    // macOS: open-url, including any buffered from before this service existed.
    // The Clerk bridge also listens here but only claims its own renderer origin.
    yield* openUrls.subscribe((url) => {
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

  const takePending = Ref.getAndSet(queueRef, []).pipe(
    Effect.withSpan("desktop.pairingLink.takePending"),
  );

  return DesktopPairingLink.of({ register, takePending });
});

export const layer = Layer.effect(DesktopPairingLink, make);
