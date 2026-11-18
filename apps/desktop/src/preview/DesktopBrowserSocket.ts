/** Carries the desktop browser channel over a WebSocket for a backend whose launcher drops fds. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { DESKTOP_BROWSER_CHANNEL_PATH, DesktopBrowserCommand } from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

import { wslLinuxPathToWindowsPath } from "../wsl/wslPathParsing.ts";

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

const commandCodec = Schema.fromJsonString(DesktopBrowserCommand);
const decodeCommand = Schema.decodeUnknownOption(commandCodec);
const encodeCommand = Schema.encodeSync(commandCodec);

/**
 * The server names files on its own filesystem: the ones to upload and the folder downloads land
 * in. A WSL server's paths mean nothing to the Windows page until they are translated.
 */
export const translateWslPaths = (line: string, distro: string): string => {
  // Most traffic is input and screencast acks; only these two commands carry paths.
  if (!line.includes("DOM.setFileInputFiles") && !line.includes("Browser.setDownloadBehavior")) {
    return line;
  }
  const command = Option.getOrUndefined(decodeCommand(line));
  if (command?.type !== "cdp") return line;
  let message: { method?: unknown; params?: Record<string, unknown> };
  try {
    message = JSON.parse(command.message);
  } catch {
    return line;
  }
  const params = message.params;
  if (typeof params !== "object" || params === null) return line;
  const translate = (path: unknown) =>
    typeof path === "string" && path.startsWith("/")
      ? wslLinuxPathToWindowsPath(distro, path)
      : path;
  if (message.method === "DOM.setFileInputFiles" && Array.isArray(params["files"])) {
    params["files"] = params["files"].map(translate);
  } else if (message.method === "Browser.setDownloadBehavior") {
    params["downloadPath"] = translate(params["downloadPath"]);
  } else {
    return line;
  }
  return encodeCommand({ ...command, message: JSON.stringify(message) });
};

/** Never returns: redials until interrupted, since the backend listens only once it has booted. */
export const run = Effect.fn("DesktopBrowserSocket.run")(function* (options: {
  readonly httpBaseUrl: URL;
  readonly secret: string;
  /** Subscribed anew on each dial, so the host announces its tabs to every connection. */
  readonly events: Stream.Stream<Uint8Array>;
  readonly onCommand: (line: string) => Effect.Effect<void>;
  /** The WSL distro the backend runs in, when its filesystem is not this machine's. */
  readonly distro?: string | undefined;
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
          (frame) => {
            const line = typeof frame === "string" ? frame : decoder.decode(frame);
            return options.onCommand(
              options.distro === undefined ? line : translateWslPaths(line, options.distro),
            );
          },
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
