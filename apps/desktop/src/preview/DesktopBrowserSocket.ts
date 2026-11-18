/** Carries the desktop browser channel over a WebSocket for a backend whose launcher drops fds. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { DESKTOP_BROWSER_CHANNEL_PATH } from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

const REDIAL_INTERVAL = "1 second";

// Effect drops its listeners before closing a socket that is still connecting, and `ws` then
// emits an `error` nobody handles, which would exit the app while the backend boots.
const webSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

/** Never returns: redials until interrupted, since the backend listens only once it has booted. */
export const run = Effect.fn("DesktopBrowserSocket.run")(function* (options: {
  readonly httpBaseUrl: URL;
  readonly secret: string;
  /** Subscribed anew on each dial, so the host announces its tabs to every connection. */
  readonly events: Stream.Stream<Uint8Array>;
  readonly onCommand: (line: string) => Effect.Effect<void>;
}) {
  const url = new URL(DESKTOP_BROWSER_CHANNEL_PATH, options.httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const decoder = new TextDecoder();
  const dial = Effect.gen(function* () {
    const token = yield* currentDesktopBootstrapToken(
      options.secret,
      yield* Clock.currentTimeMillis,
    );
    const socket = yield* Socket.makeWebSocket(url.href, {
      openTimeout: "10 seconds",
      headers: { authorization: `Bearer ${token}` },
    });
    const writer = yield* socket.writer;
    const reader = yield* socket.reader;
    const commands = reader.pull.pipe(
      Effect.flatMap((frames) =>
        Effect.forEach(
          frames,
          (frame) => options.onCommand(typeof frame === "string" ? frame : decoder.decode(frame)),
          { discard: true },
        ),
      ),
      Effect.forever,
    );
    const events = options.events.pipe(
      Stream.runForEach((line) => writer.write(decoder.decode(line))),
    );
    return yield* Effect.raceFirst(commands, events);
  }).pipe(Effect.scoped, Effect.ignore);
  return yield* dial.pipe(
    Effect.repeat(Schedule.spaced(REDIAL_INTERVAL)),
    Effect.provide(Layer.merge(webSocketConstructor, NodeCrypto.layer)),
  );
});
