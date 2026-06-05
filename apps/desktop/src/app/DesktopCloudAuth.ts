import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import type * as Electron from "electron";

export const CLOUD_AUTH_CALLBACK_HOST = "auth";
export const CLOUD_AUTH_CALLBACK_PATHNAME = "/callback";
export const CLOUD_AUTH_CALLBACK_STATE_PARAM = "t3_state";
export const CLOUD_AUTH_CALLBACK_SCHEME = "t3code";
export const DEVELOPMENT_CLOUD_AUTH_CALLBACK_SCHEME = "t3code-dev";

const CLOUD_AUTH_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export class DesktopCloudAuthCallbackServerError extends Data.TaggedError(
  "DesktopCloudAuthCallbackServerError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Failed to start the desktop cloud auth callback server.";
  }
}

interface PendingCloudAuthRequest {
  readonly state: string;
  readonly redirectUrl: string;
  readonly close: () => void;
}

export interface DesktopCloudAuthShape {
  readonly createRequest: Effect.Effect<string, DesktopCloudAuthCallbackServerError>;
  readonly configure: Effect.Effect<
    void,
    never,
    ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
  >;
}

export class DesktopCloudAuth extends Context.Service<DesktopCloudAuth, DesktopCloudAuthShape>()(
  "@t3tools/desktop/app/DesktopCloudAuth",
) {}

export function resolveCloudAuthCallbackScheme(input: { readonly isDevelopment: boolean }): string {
  return input.isDevelopment ? DEVELOPMENT_CLOUD_AUTH_CALLBACK_SCHEME : CLOUD_AUTH_CALLBACK_SCHEME;
}

export function buildCloudAuthCallbackUrl(input: {
  readonly scheme: string;
  readonly state: string;
}): string {
  const url = new URL(
    `${input.scheme}://${CLOUD_AUTH_CALLBACK_HOST}${CLOUD_AUTH_CALLBACK_PATHNAME}`,
  );
  url.searchParams.set(CLOUD_AUTH_CALLBACK_STATE_PARAM, input.state);
  return url.toString();
}

export function parseCloudAuthCallbackUrl(input: {
  readonly rawUrl: unknown;
  readonly scheme: string;
  readonly state: string;
}): URL | null {
  if (typeof input.rawUrl !== "string") {
    return null;
  }

  try {
    const url = new URL(input.rawUrl);
    if (url.protocol !== `${input.scheme}:`) return null;
    if (url.hostname !== CLOUD_AUTH_CALLBACK_HOST) return null;
    if (url.pathname !== CLOUD_AUTH_CALLBACK_PATHNAME) return null;
    if (url.searchParams.get(CLOUD_AUTH_CALLBACK_STATE_PARAM) !== input.state) return null;
    return url;
  } catch {
    return null;
  }
}

export function findCloudAuthCallbackUrl(input: {
  readonly values: readonly unknown[];
  readonly scheme: string;
  readonly state: string;
}): URL | null {
  for (const value of input.values) {
    const url = parseCloudAuthCallbackUrl({
      rawUrl: value,
      scheme: input.scheme,
      state: input.state,
    });
    if (url) return url;
  }
  return null;
}

export function resolveProtocolClientLaunchArgs(input: {
  readonly argv: readonly string[];
}): readonly string[] {
  return input.argv.slice(1);
}

function resolveConfiguredProtocolClient(): {
  readonly path: string;
  readonly args: readonly string[];
} | null {
  const path = process.env.T3CODE_DESKTOP_PROTOCOL_CLIENT_PATH?.trim();
  if (!path) return null;

  return {
    path,
    args: (process.env.T3CODE_DESKTOP_PROTOCOL_CLIENT_ARGS ?? "")
      .split("\n")
      .map((arg) => arg.trim())
      .filter((arg) => arg.length > 0),
  };
}

function isProtocolRegistrationManagedExternally(): boolean {
  return process.env.T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED?.trim() === "1";
}

function resolveProtocolCallbackForwardUrl(): URL | null {
  const rawUrl = process.env.T3CODE_DESKTOP_PROTOCOL_CALLBACK_URL?.trim();
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:") return null;
    if (url.hostname !== "127.0.0.1") return null;
    if (url.pathname !== "/auth/callback") return null;
    if (!url.port) return null;
    return url;
  } catch {
    return null;
  }
}

const closeCloudAuthRequest = (request: PendingCloudAuthRequest | null): null => {
  request?.close();
  return null;
};

function createCloudAuthRequestTimeout(onExpire: () => void): ReturnType<typeof setTimeout> {
  // @effect-diagnostics-next-line globalTimers:off - Auth request expiry is tied to an Electron callback server, not fiber scheduling.
  return setTimeout(onExpire, CLOUD_AUTH_REQUEST_TIMEOUT_MS);
}

function ignoreCloudAuthCallback(_rawUrl: string) {}

function startProtocolCallbackForwardServer(
  callbackUrl: URL,
  dispatch: (rawUrl: string) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const port = Number.parseInt(callbackUrl.port, 10);
  const routesLayer = HttpRouter.add(
    "POST",
    "/auth/callback",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const rawUrl = yield* request.text;
      yield* Effect.sync(() => {
        dispatch(rawUrl);
      });
      return HttpServerResponse.empty({ status: 204 });
    }),
  );

  return Effect.gen(function* () {
    const NodeHttp = yield* Effect.promise(() => import("node:http"));
    const serverLayer = NodeHttpServer.layer(NodeHttp.createServer, {
      host: callbackUrl.hostname,
      port,
    });
    yield* Layer.launch(HttpRouter.serve(routesLayer).pipe(Layer.provideMerge(serverLayer))).pipe(
      Effect.forkScoped,
    );
  });
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  let pendingAuthRequest: PendingCloudAuthRequest | null = null;
  let dispatchCloudAuthCallback: (rawUrl: string) => void = ignoreCloudAuthCallback;
  const makeCloudAuthRequestState = Effect.gen(function* () {
    const [left, right] = yield* Effect.all([crypto.randomUUIDv4, crypto.randomUUIDv4]);
    return `${left}${right}`.replaceAll("-", "");
  });

  return DesktopCloudAuth.of({
    createRequest: Effect.gen(function* () {
      const scheme = resolveCloudAuthCallbackScheme({
        isDevelopment: environment.isDevelopment,
      });
      const state = yield* makeCloudAuthRequestState.pipe(
        Effect.mapError((cause) => new DesktopCloudAuthCallbackServerError({ cause })),
      );

      pendingAuthRequest = closeCloudAuthRequest(pendingAuthRequest);

      const redirectUrl = buildCloudAuthCallbackUrl({ scheme, state });
      const timeout = createCloudAuthRequestTimeout(() => {
        pendingAuthRequest = closeCloudAuthRequest(pendingAuthRequest);
      });
      pendingAuthRequest = {
        state,
        redirectUrl,
        close: () => clearTimeout(timeout),
      };
      return redirectUrl;
    }),
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const scope = yield* Scope.Scope;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);
      const scheme = resolveCloudAuthCallbackScheme({
        isDevelopment: environment.isDevelopment,
      });

      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          pendingAuthRequest = closeCloudAuthRequest(pendingAuthRequest);
        }),
      );

      if (isProtocolRegistrationManagedExternally()) {
        // Development macOS launchers set the default URL handler before the stock Electron
        // process starts so LaunchServices binds the scheme to the worktree-specific app bundle.
      } else if (environment.isDevelopment) {
        const configuredClient = resolveConfiguredProtocolClient();
        if (configuredClient) {
          yield* electronApp.setAsDefaultProtocolClient(
            scheme,
            configuredClient.path,
            configuredClient.args,
          );
        } else {
          yield* electronApp.setAsDefaultProtocolClient(
            scheme,
            process.execPath,
            resolveProtocolClientLaunchArgs({ argv: process.argv }),
          );
        }
      } else {
        yield* electronApp.setAsDefaultProtocolClient(scheme);
      }

      dispatchCloudAuthCallback = (rawUrl: string) => {
        const pending = pendingAuthRequest;
        const callbackUrl = pending
          ? parseCloudAuthCallbackUrl({ rawUrl, scheme, state: pending.state })
          : null;
        if (!callbackUrl) {
          return;
        }

        pendingAuthRequest = closeCloudAuthRequest(pendingAuthRequest);
        void runPromise(
          Effect.gen(function* () {
            yield* electronWindow.sendAll(
              IpcChannels.CLOUD_AUTH_CALLBACK_CHANNEL,
              callbackUrl.toString(),
            );
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) {
              yield* electronWindow.reveal(mainWindow.value);
            }
          }),
        );
      };

      const protocolCallbackForwardUrl = resolveProtocolCallbackForwardUrl();
      if (environment.isDevelopment && protocolCallbackForwardUrl) {
        yield* startProtocolCallbackForwardServer(
          protocolCallbackForwardUrl,
          dispatchCloudAuthCallback,
        );
      }

      const hasInstanceLock = yield* electronApp.requestSingleInstanceLock;
      if (!hasInstanceLock) {
        return yield* electronApp.quit;
      }

      yield* electronApp.on<[Electron.Event, string]>("open-url", (event, rawUrl) => {
        event.preventDefault?.();
        dispatchCloudAuthCallback(rawUrl);
      });

      yield* electronApp.on<[Electron.Event, readonly string[]]>(
        "second-instance",
        (_event, argv) => {
          const values = resolveProtocolClientLaunchArgs({ argv });
          const pending = pendingAuthRequest;
          const callbackUrl = pending
            ? findCloudAuthCallbackUrl({ values, scheme, state: pending.state })
            : null;
          if (callbackUrl) {
            dispatchCloudAuthCallback(callbackUrl.toString());
            return;
          }

          void runPromise(
            Effect.gen(function* () {
              const mainWindow = yield* electronWindow.currentMainOrFirst;
              if (Option.isSome(mainWindow)) {
                yield* electronWindow.reveal(mainWindow.value);
              }
            }),
          );
        },
      );
    }).pipe(Effect.withSpan("desktop.cloudAuth.configure")),
  });
});

export const layer = Layer.effect(DesktopCloudAuth, make);
