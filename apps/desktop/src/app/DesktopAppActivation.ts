// @effect-diagnostics nodeBuiltinImport:off -- Local socket ownership checks need lstat uid and an atomic stale-socket unlink at the Node adapter boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import { HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const isDesktopAppActivationRequest = Schema.is(DesktopAppActivationRequest);

export class DesktopAppActivationStartError extends Schema.TaggedErrorClass<DesktopAppActivationStartError>()(
  "DesktopAppActivationStartError",
  {
    address: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start the desktop app control socket at ${this.address}.`;
  }
}

interface RunningControlServer {
  readonly close: () => Promise<void>;
}

function invalidResponse(requestId: string, message: string): DesktopAppActivationResponse {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code: "invalid-request",
    message,
  };
}

function requestIdFromUnknown(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    value.requestId.trim().length > 0
  ) {
    return value.requestId;
  }
  return "invalid-request";
}

async function prepareUnixSocket(input: {
  readonly address: string;
  readonly directory: string;
  readonly userId: number | undefined;
}): Promise<void> {
  await NodeFSP.mkdir(input.directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(input.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${input.directory} is not a directory.`);
  }
  if (input.userId !== undefined && stat.uid !== input.userId) {
    throw new Error(`${input.directory} is owned by another user.`);
  }
  await NodeFSP.chmod(input.directory, 0o700);
  await NodeFSP.unlink(input.address).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function startDesktopAppControlServer(input: {
  readonly address: string;
  readonly directory: string | null;
  readonly userId: number | undefined;
  readonly handle: (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
  readonly cancel: (requestId: string) => void;
}): Promise<RunningControlServer> {
  if (input.directory !== null) {
    await prepareUnixSocket({
      address: input.address,
      directory: input.directory,
      userId: input.userId,
    });
  }

  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    let responseSent = false;
    let activeRequestId: string | null = null;

    socket.setTimeout(5_000, () => socket.destroy());

    const finish = (response: DesktopAppActivationResponse) => {
      responseSent = true;
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        finish(invalidResponse("invalid-request", "The desktop app request is too large."));
        return;
      }

      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      socket.setTimeout(0);
      const line = buffer.slice(0, newline);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(invalidResponse("invalid-request", "The desktop app request is not valid JSON."));
        return;
      }

      if (!isDesktopAppActivationRequest(parsed)) {
        finish(
          invalidResponse(requestIdFromUnknown(parsed), "The desktop app request is invalid."),
        );
        return;
      }
      activeRequestId = parsed.requestId;
      void input.handle(parsed).then(finish, () => {
        finish(
          invalidResponse(parsed.requestId, "T3 Code could not process the desktop app request."),
        );
      });
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      if (!responseSent && activeRequestId !== null) input.cancel(activeRequestId);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(input.address);
  });

  try {
    if (input.directory !== null) {
      await NodeFSP.chmod(input.address, 0o600);
    }
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.removeAllListeners();
      if (input.directory !== null) {
        await NodeFSP.unlink(input.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

export class DesktopAppActivation extends Context.Service<
  DesktopAppActivation,
  {
    readonly start: Effect.Effect<void, DesktopAppActivationStartError, Scope.Scope>;
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
    readonly complete: (response: DesktopAppActivationResponse) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppActivation") {}

const { logWarning } = makeComponentLogger("desktop-app-activation");

export const make = Effect.gen(function* () {
  const desktopEnvironment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const path = yield* Path.Path;
  const userId = yield* HostProcessUserId;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const address = resolveDesktopAppControlAddress({
    stateDir: path.resolve(desktopEnvironment.stateDir),
    platform: desktopEnvironment.platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: path.join,
  });
  let registeredWebContents: Electron.WebContents | null = null;
  let detachRendererListeners: (() => void) | null = null;

  const broker = new DesktopAppActivationBroker({
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    activate: () => {
      void runPromise(
        desktopWindow.activate.pipe(
          Effect.catchCause((cause) => logWarning("failed to focus the desktop window", { cause })),
        ),
      );
    },
  });

  const clearRegisteredRenderer = () => {
    detachRendererListeners?.();
    detachRendererListeners = null;
    registeredWebContents = null;
    broker.clearRenderer();
  };

  return DesktopAppActivation.of({
    start: Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startDesktopAppControlServer({
            ...address,
            userId,
            handle: (request) => broker.request(request),
            cancel: (requestId) => broker.cancel(requestId),
          }),
        catch: (cause) => new DesktopAppActivationStartError({ address: address.address, cause }),
      }),
      (server) =>
        Effect.promise(() => server.close()).pipe(
          Effect.catchCause((cause) =>
            logWarning("failed to close the desktop app control socket", { cause }),
          ),
          Effect.ensuring(Effect.sync(() => broker.close())),
        ),
    ).pipe(Effect.asVoid),
    setRendererReady: Effect.fn("DesktopAppActivation.setRendererReady")(function* (ready) {
      if (!ready) {
        clearRegisteredRenderer();
        return;
      }
      const main = yield* electronWindow.main;
      if (Option.isNone(main)) return;
      const webContents = main.value.webContents;
      if (webContents.isDestroyed()) return;

      if (registeredWebContents !== webContents) {
        clearRegisteredRenderer();
        registeredWebContents = webContents;
        const onUnavailable = () => clearRegisteredRenderer();
        const onNavigation = (
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame && !event.isSameDocument) clearRegisteredRenderer();
        };
        webContents.on("did-start-navigation", onNavigation);
        webContents.once("destroyed", onUnavailable);
        detachRendererListeners = () => {
          webContents.removeListener("did-start-navigation", onNavigation);
          webContents.removeListener("destroyed", onUnavailable);
        };
      }

      broker.registerRenderer((request) => {
        webContents.send(DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, request);
      });
    }),
    complete: (response) => Effect.sync(() => broker.complete(response)),
  });
});

export const layer = Layer.effect(DesktopAppActivation, make);
