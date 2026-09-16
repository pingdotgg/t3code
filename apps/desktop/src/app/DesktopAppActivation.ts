// @effect-diagnostics nodeBuiltinImport:off -- Local socket ownership checks need lstat uid and an atomic stale-socket unlink at the Node adapter boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
  type DesktopAppConnectionCompletion,
  DesktopAppConnectionRequest,
  type DesktopAppConnectionResponse,
  desktopAppConnectionFailure,
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
import {
  DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL,
  DESKTOP_APP_CONNECTION_CANCEL_CHANNEL,
  DESKTOP_APP_CONNECTION_REQUEST_CHANNEL,
} from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";
import { DesktopAppConnectionBroker } from "./DesktopAppConnectionBroker.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
// Connection requests may cross SSH or the relay, so they get a longer budget
// than a local activation, and a bounded number may be in flight at once.
const CONNECTION_REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_MAX_PENDING = 32;
const isDesktopAppActivationRequest = Schema.is(DesktopAppActivationRequest);
const isDesktopAppConnectionRequest = Schema.is(DesktopAppConnectionRequest);

type DesktopAppControlResponse = DesktopAppActivationResponse | DesktopAppConnectionResponse;

function isConnectionRequestShape(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "type" in value && value.type === "connection"
  );
}

export class DesktopAppActivationStartError extends Schema.TaggedError<DesktopAppActivationStartError>()(
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
  readonly handleConnection?: (
    request: DesktopAppConnectionRequest,
  ) => Promise<DesktopAppConnectionResponse>;
  readonly cancelConnection?: (request: DesktopAppConnectionRequest) => void;
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
    // Cancellation is bound to this socket's own parsed request so a rejected
    // duplicate id can never cancel another socket's request.
    let cancelActive: (() => void) | null = null;

    socket.setTimeout(5_000, () => socket.destroy());

    const finish = (response: DesktopAppControlResponse) => {
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

      if (isConnectionRequestShape(parsed)) {
        if (!isDesktopAppConnectionRequest(parsed) || input.handleConnection === undefined) {
          finish(
            desktopAppConnectionFailure(
              requestIdFromUnknown(parsed),
              "invalid-request",
              "The desktop app connection request is invalid.",
            ),
          );
          return;
        }
        const cancelConnection = input.cancelConnection;
        cancelActive = cancelConnection === undefined ? null : () => cancelConnection(parsed);
        void input.handleConnection(parsed).then(finish, () => {
          finish(
            desktopAppConnectionFailure(
              parsed.requestId,
              "internal-error",
              "T3 Code could not process the desktop app connection request.",
            ),
          );
        });
        return;
      }

      if (!isDesktopAppActivationRequest(parsed)) {
        finish(
          invalidResponse(requestIdFromUnknown(parsed), "The desktop app request is invalid."),
        );
        return;
      }
      cancelActive = () => input.cancel(parsed.requestId);
      void input.handle(parsed).then(finish, () => {
        finish(
          invalidResponse(parsed.requestId, "T3 Code could not process the desktop app request."),
        );
      });
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      if (!responseSent) cancelActive?.();
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
    readonly setConnectionRendererReady: (ready: boolean) => Effect.Effect<void>;
    readonly completeConnection: (
      completion: DesktopAppConnectionCompletion,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppActivation") {}

const { logWarning } = makeComponentLogger("desktop-app-activation");

/** @public Service construction is part of the canonical Effect module API. */
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

  const connectionBroker = new DesktopAppConnectionBroker({
    requestTimeoutMs: CONNECTION_REQUEST_TIMEOUT_MS,
    maxPending: CONNECTION_MAX_PENDING,
    nextDispatchId: () => NodeCrypto.randomUUID(),
  });

  const clearRegisteredRenderer = () => {
    detachRendererListeners?.();
    detachRendererListeners = null;
    registeredWebContents = null;
    broker.clearRenderer();
    connectionBroker.clearRenderer();
  };

  // Both brokers share one renderer: tracking it once keeps reload and close
  // cleanup identical for activation and connection requests.
  const trackRenderer = Effect.fn("DesktopAppActivation.trackRenderer")(function* () {
    const main = yield* electronWindow.main;
    if (Option.isNone(main)) return null;
    const webContents = main.value.webContents;
    if (webContents.isDestroyed()) return null;

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
    return webContents;
  });

  return DesktopAppActivation.of({
    start: Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startDesktopAppControlServer({
            ...address,
            userId,
            handle: (request) => broker.request(request),
            cancel: (requestId) => broker.cancel(requestId),
            handleConnection: (request) => connectionBroker.request(request),
            cancelConnection: (request) => connectionBroker.cancel(request),
          }),
        catch: (cause) => new DesktopAppActivationStartError({ address: address.address, cause }),
      }),
      (server) =>
        Effect.promise(() => server.close()).pipe(
          Effect.catchCause((cause) =>
            logWarning("failed to close the desktop app control socket", { cause }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              broker.close();
              connectionBroker.close();
            }),
          ),
        ),
    ).pipe(Effect.asVoid),
    setRendererReady: Effect.fn("DesktopAppActivation.setRendererReady")(function* (ready) {
      if (!ready) {
        broker.clearRenderer();
        return;
      }
      const webContents = yield* trackRenderer();
      if (webContents === null) return;
      broker.registerRenderer((request) => {
        webContents.send(DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, request);
      });
    }),
    setConnectionRendererReady: Effect.fn("DesktopAppActivation.setConnectionRendererReady")(
      function* (ready) {
        if (!ready) {
          connectionBroker.clearRenderer();
          return;
        }
        const webContents = yield* trackRenderer();
        if (webContents === null) return;
        connectionBroker.registerRenderer({
          dispatch: (dispatch) => {
            webContents.send(DESKTOP_APP_CONNECTION_REQUEST_CHANNEL, dispatch);
          },
          cancel: (dispatchId) => {
            if (!webContents.isDestroyed()) {
              webContents.send(DESKTOP_APP_CONNECTION_CANCEL_CHANNEL, dispatchId);
            }
          },
        });
      },
    ),
    complete: (response) => Effect.sync(() => broker.complete(response)),
    completeConnection: (completion) => Effect.sync(() => connectionBroker.complete(completion)),
  });
});

export const layer = Layer.effect(DesktopAppActivation, make);
