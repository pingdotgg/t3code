import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import type { DesktopThreadDeepLinkPayload } from "@t3tools/contracts";
import { HostProcessArguments } from "@t3tools/shared/hostProcess";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import {
  DEEP_LINK_CHANNEL,
  DEEP_LINK_REQUEUE_CHANNEL,
  DEEP_LINK_SUBSCRIBE_CHANNEL,
  DEEP_LINK_UNSUBSCRIBE_CHANNEL,
} from "../ipc/channels.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-deep-link");

const UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Parses a thread deep link of exactly the shape
 * `<scheme>://app/<environmentId>/<threadId>` where both ids are UUIDs.
 *
 * The scheme and host compare case-insensitively (URL semantics) and UUID
 * casing is normalized to lowercase. Everything else is rejected — extra or
 * missing path segments, non-UUID segments, query strings, fragments, and
 * trailing slashes — so the URL scheme cannot become an arbitrary-navigation
 * primitive and OAuth callback URLs pass through to their own listeners.
 */
export function parseThreadDeepLink(
  url: string,
  scheme: string,
): DesktopThreadDeepLinkPayload | null {
  const pattern = new RegExp(
    `^${scheme}://${ElectronProtocol.DESKTOP_HOST}/(${UUID_SEGMENT})/(${UUID_SEGMENT})$`,
    "i",
  );
  const match = pattern.exec(url);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    environmentId: match[1].toLowerCase(),
    threadId: match[2].toLowerCase(),
  };
}

/**
 * Windows and Linux deliver protocol URLs as a command-line argument rather
 * than an event, so the URL has to be fished out of argv.
 */
export function findThreadDeepLinkInArgv(
  argv: ReadonlyArray<string>,
  scheme: string,
): DesktopThreadDeepLinkPayload | null {
  for (const entry of argv) {
    const payload = parseThreadDeepLink(entry, scheme);
    if (payload !== null) {
      return payload;
    }
  }
  return null;
}

interface EarlyOpenUrlSource {
  on(event: "open-url", listener: (event: unknown, url: string) => void): unknown;
  removeListener(event: "open-url", listener: (event: unknown, url: string) => void): unknown;
}

export interface EarlyOpenUrlCapture {
  /**
   * Detach the early listener and return the raw URLs captured so far.
   * Draining a handle twice returns nothing the second time.
   */
  readonly drain: () => ReadonlyArray<string>;
}

const emptyEarlyOpenUrlCapture: EarlyOpenUrlCapture = { drain: () => [] };

/**
 * The capture handle created by `main.ts` before the Effect runtime exists
 * and provided to the deep-link layer. Defaults to an empty capture so
 * entry points and tests that never early-capture need no setup.
 */
export const EarlyOpenUrlCapture = Context.Reference<EarlyOpenUrlCapture>(
  "@t3tools/desktop/app/DesktopDeepLink/EarlyOpenUrlCapture",
  { defaultValue: () => emptyEarlyOpenUrlCapture },
);

/**
 * Must run at the earliest synchronous point of main-process startup: macOS
 * can emit the cold-start open-url before the deep-link service's own
 * listener exists, and an unheard event is simply lost. Capture only — no
 * parsing, no preventDefault — so OAuth callbacks and every other URL keep
 * flowing to their own listeners. The returned handle is an explicit input
 * to the service; `configure` drains it through the normal parse path,
 * which also detaches this listener.
 */
export function captureEarlyOpenUrls(source: EarlyOpenUrlSource): EarlyOpenUrlCapture {
  const urls: string[] = [];
  const listener = (_event: unknown, url: string) => {
    if (typeof url === "string") {
      urls.push(url);
    }
  };
  source.on("open-url", listener);
  let drained = false;
  return {
    drain: () => {
      if (drained) return [];
      drained = true;
      source.removeListener("open-url", listener);
      return [...urls];
    },
  };
}

export class DesktopDeepLink extends Context.Service<
  DesktopDeepLink,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | DesktopIpc.DesktopIpc | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopDeepLink") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const earlyCapture = yield* EarlyOpenUrlCapture;
  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);

  // Last-wins buffer for links that arrive before any renderer subscribes.
  const pending = yield* Ref.make<Option.Option<DesktopThreadDeepLinkPayload>>(Option.none());
  const generation = yield* Ref.make(0);

  // Renderer webContents that completed the subscribe handshake, oldest
  // first. A subscriber has mounted its deep-link listener, so a push cannot
  // race the renderer's startup — and the WSL splash never subscribes, so it
  // can never swallow a link. Entries drop three ways: the renderer explicitly
  // unsubscribes when its listener tears down (e.g. navigating to /connect or
  // /pair, which unmounts the deep-link component while the webContents stays
  // alive), the webContents fires destroyed, or a stale entry is pruned on use.
  const subscribers: DesktopIpc.DesktopIpcSenderWebContents[] = [];

  const removeSubscriber = (sender: DesktopIpc.DesktopIpcSenderWebContents) => {
    const index = subscribers.indexOf(sender);
    if (index !== -1) {
      subscribers.splice(index, 1);
    }
  };

  const latestLiveSubscriber = (): DesktopIpc.DesktopIpcSenderWebContents | null => {
    for (let index = subscribers.length - 1; index >= 0; index -= 1) {
      const subscriber = subscribers[index];
      if (subscriber === undefined || subscriber.isDestroyed()) {
        subscribers.splice(index, 1);
        continue;
      }
      return subscriber;
    }
    return null;
  };

  const subscribe = (sender: DesktopIpc.DesktopIpcSenderWebContents | undefined) =>
    Effect.gen(function* () {
      const currentGeneration = yield* Ref.get(generation);
      if (sender === undefined || sender.isDestroyed()) {
        return { payload: null, generation: currentGeneration };
      }
      yield* Effect.sync(() => {
        if (!subscribers.includes(sender)) {
          subscribers.push(sender);
          sender.once("destroyed", () => removeSubscriber(sender));
        }
      });
      const payload = yield* Ref.getAndSet(pending, Option.none());
      return {
        payload: Option.getOrNull(payload),
        generation: currentGeneration,
      };
    });

  // The renderer's preload invokes this when its deep-link listener tears
  // down. Without it a reloaded or route-unmounted renderer would stay in the
  // registry with a live webContents but no listener, so a link would be
  // pushed into a void and lost instead of buffered for the next subscriber.
  const unsubscribe = (sender: DesktopIpc.DesktopIpcSenderWebContents | undefined) =>
    Effect.sync(() => {
      if (sender !== undefined) {
        removeSubscriber(sender);
      }
      return null;
    });

  return DesktopDeepLink.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const ipc = yield* DesktopIpc.DesktopIpc;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      const open = (payload: DesktopThreadDeepLinkPayload) =>
        Effect.gen(function* () {
          yield* Ref.update(generation, (value) => value + 1);
          const subscriber = latestLiveSubscriber();
          if (subscriber === null) {
            yield* Ref.set(pending, Option.some(payload));
            yield* logInfo("thread deep link buffered until a renderer subscribes", {
              environmentId: payload.environmentId,
              threadId: payload.threadId,
            });
            return;
          }
          const window = yield* electronWindow.fromWebContentsId(subscriber.id);
          if (Option.isSome(window)) {
            yield* electronWindow.reveal(window.value);
          }
          const delivered = yield* Effect.sync(() => {
            if (subscriber.isDestroyed()) return false;
            subscriber.send(DEEP_LINK_CHANNEL, payload);
            return true;
          });
          if (!delivered) {
            // The subscriber died between selection and send; keep the link
            // for the next subscriber instead of dropping it.
            removeSubscriber(subscriber);
            yield* Ref.set(pending, Option.some(payload));
            return;
          }
          yield* logInfo("thread deep link delivered", {
            environmentId: payload.environmentId,
            threadId: payload.threadId,
          });
        });

      // The renderer's preload invokes this once its deep-link listener is
      // mounted: register it for future pushes and hand back the buffered
      // link, if any (cold start).
      yield* ipc
        .handle({
          channel: DEEP_LINK_SUBSCRIBE_CHANNEL,
          handler: (_raw, event) => subscribe(event?.sender),
        })
        .pipe(
          // Deep links must never block startup.
          Effect.catch((error) =>
            logWarning("deep link subscribe handler registration failed", {
              message: error.message,
            }),
          ),
        );

      // The preload invokes this as its listener tears down so a renderer that
      // is still alive but no longer listening (route unmount, reload) stops
      // being a delivery target and links buffer for the next subscriber.
      yield* ipc
        .handle({
          channel: DEEP_LINK_UNSUBSCRIBE_CHANNEL,
          handler: (_raw, event) => unsubscribe(event?.sender),
        })
        .pipe(
          Effect.catch((error) =>
            logWarning("deep link unsubscribe handler registration failed", {
              message: error.message,
            }),
          ),
        );

      yield* ipc
        .handle({
          channel: DEEP_LINK_REQUEUE_CHANNEL,
          handler: (raw) => {
            const payload = raw as Record<string, unknown> | null;
            const requeuedPayload = payload?.payload as Record<string, unknown> | null | undefined;
            const environmentId = requeuedPayload?.environmentId;
            const threadId = requeuedPayload?.threadId;
            if (
              payload === null ||
              typeof payload !== "object" ||
              requeuedPayload === null ||
              typeof requeuedPayload !== "object" ||
              typeof environmentId !== "string" ||
              typeof threadId !== "string" ||
              typeof payload.generation !== "number"
            ) {
              return Effect.succeed(null);
            }
            return Effect.gen(function* () {
              if ((yield* Ref.get(generation)) !== payload.generation) return null;
              return yield* open({ environmentId, threadId });
            });
          },
        })
        .pipe(
          Effect.catch((error) =>
            logWarning("deep link requeue handler registration failed", {
              message: error.message,
            }),
          ),
        );

      // macOS delivers protocol URLs as open-url events. OAuth callback URLs
      // must keep flowing to the Clerk bridge listeners, so anything that is
      // not exactly a thread link is left untouched — no preventDefault.
      yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
        const payload = parseThreadDeepLink(url, scheme);
        if (payload === null) return;
        event.preventDefault();
        void runPromise(open(payload));
      });

      // Windows/Linux forward protocol URLs from secondary instances as argv.
      yield* electronApp.on("second-instance", (_event: unknown, argv: ReadonlyArray<string>) => {
        const payload = findThreadDeepLinkInArgv(argv, scheme);
        if (payload === null) return;
        void runPromise(open(payload));
      });

      // Cold starts: URLs stashed by the early capture before this service
      // existed (macOS; latest wins) and the primary instance's own command
      // line (Windows/Linux).
      const processArguments = yield* HostProcessArguments;
      const earlyUrls = earlyCapture.drain().toReversed();
      const initial =
        findThreadDeepLinkInArgv(earlyUrls, scheme) ??
        findThreadDeepLinkInArgv(processArguments, scheme);
      if (initial !== null) {
        yield* open(initial);
      }
    }).pipe(Effect.withSpan("desktop.deepLink.configure")),
  });
});

export const layer = Layer.effect(DesktopDeepLink, make);
