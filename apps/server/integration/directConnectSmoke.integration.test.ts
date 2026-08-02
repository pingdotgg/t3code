import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthStandardClientScopes,
  CommandId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  WS_METHODS,
} from "@t3tools/contracts";
import { chromium } from "playwright";
import {
  Deferred,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Scope,
} from "effect";
import { expect, it } from "vitest";

import {
  deriveServerPaths,
  ensureServerDirectories,
  ServerConfig,
  type ServerConfigShape,
} from "../src/config.ts";
import { makeServerLayer } from "../src/server.ts";
import { readPersistedServerRuntimeState } from "../src/serverRuntimeState.ts";
import { preparePairingRegistration } from "../../../packages/client-runtime/src/connection/onboarding.ts";
import { ClientPresentation } from "../../../packages/client-runtime/src/platform/capabilities.ts";
import { remoteHttpClientLayer } from "../../../packages/client-runtime/src/rpc/http.ts";
import { resolveRemoteWebSocketConnectionUrl } from "../../../packages/client-runtime/src/remote.ts";
import { WsTransport } from "../../../packages/client-runtime/src/wsTransport.ts";

const desktopBootstrapToken = "direct-connect-smoke-owner";
const projectId = ProjectId.make("project-direct-connect-smoke");
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;
const productionServerLayer: Layer.Layer<never, unknown, ServerConfig> = makeServerLayer;

class DirectConnectSmokeError extends Data.TaggedError("DirectConnectSmokeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function retryUntil<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  description: string,
): Effect.Effect<A, E | DirectConnectSmokeError, R> {
  return effect.pipe(
    Effect.flatMap((value) =>
      predicate(value)
        ? Effect.succeed(value)
        : Effect.fail(new DirectConnectSmokeError({ message: description })),
    ),
    Effect.retry({
      schedule: Schedule.spaced("25 millis"),
      times: 399,
    }),
    Effect.mapError(
      (cause) =>
        new DirectConnectSmokeError({
          message: `Timed out waiting for ${description}.`,
          cause,
        }),
    ),
  );
}

function fetchJson<A>(
  url: string,
  init?: RequestInit,
): Effect.Effect<{ readonly body: A; readonly response: Response }, DirectConnectSmokeError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, init);
      const body = (await response.json()) as A;
      if (!response.ok) {
        throw new Error(`Request failed (${response.status}): ${JSON.stringify(body)}`);
      }
      return { body, response };
    },
    catch: (cause) =>
      new DirectConnectSmokeError({
        message: `Request to ${url} failed.`,
        cause,
      }),
  });
}

it("runs production direct pairing, browser bootstrap, live sync, and involuntary reconnect", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-direct-connect-smoke-",
        });
        const workspaceDir = path.join(baseDir, "workspace");
        yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
        const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
        yield* ensureServerDirectories(derivedPaths);
        const config: ServerConfigShape = {
          logLevel: "Error",
          traceMinLevel: "Error",
          traceTimingEnabled: false,
          traceBatchWindowMs: 200,
          traceMaxBytes: 10 * 1024 * 1024,
          traceMaxFiles: 2,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpExportIntervalMs: 10_000,
          otlpServiceName: "t3-direct-connect-smoke",
          mode: "desktop",
          port: 0,
          host: "127.0.0.1",
          cwd: workspaceDir,
          baseDir,
          ...derivedPaths,
          staticDir: path.resolve(import.meta.dirname, "../../web/dist"),
          devUrl: undefined,
          noBrowser: true,
          startupPresentation: "browser",
          desktopBootstrapToken,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
        };

        const serverScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
        yield* Layer.build(
          productionServerLayer.pipe(Layer.provide(Layer.succeed(ServerConfig, config))),
        ).pipe(Scope.provide(serverScope));

        const runtimeState = yield* retryUntil(
          readPersistedServerRuntimeState(config.serverRuntimeStatePath),
          Option.isSome,
          "the production HTTP listener",
        );
        const origin = Option.getOrThrow(runtimeState).origin;

        const ownerBootstrap = yield* fetchJson<{ readonly sessionToken: string }>(
          `${origin}/api/auth/bootstrap/bearer`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ credential: desktopBootstrapToken }),
          },
        );
        const ownerToken = ownerBootstrap.body.sessionToken;
        const createPairingCredential = Effect.gen(function* () {
          const result = yield* fetchJson<{ readonly credential: string }>(
            `${origin}/api/auth/pairing-token`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${ownerToken}` },
            },
          );
          return result.body.credential;
        });

        const mobileCredential = yield* createPairingCredential;
        const registration = yield* preparePairingRegistration({
          pairingUrl: `${origin}/pair#token=${encodeURIComponent(mobileCredential)}`,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              remoteHttpClientLayer(globalThis.fetch),
              Layer.succeed(
                ClientPresentation,
                ClientPresentation.of({
                  metadata: {
                    label: "Direct Connect Smoke Mobile",
                    deviceType: "mobile",
                    os: "Test",
                  },
                  scopes: AuthStandardClientScopes,
                }),
              ),
            ),
          ),
        );
        const unauthorizedSnapshot = yield* Effect.promise(() =>
          fetch(`${origin}/api/orchestration/shell-snapshot`),
        );
        expect(unauthorizedSnapshot.status).toBe(401);
        const clientPairingAttempt = yield* Effect.promise(() =>
          fetch(`${origin}/api/auth/pairing-token`, {
            method: "POST",
            headers: { authorization: `Bearer ${registration.credential.token}` },
          }),
        );
        expect(clientPairingAttempt.status).toBe(403);

        const opened = yield* Deferred.make<void>();
        const disconnected = yield* Deferred.make<void>();
        const reconnected = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const initialSnapshot = yield* Deferred.make<void>();
        const liveProjectEvent = yield* Deferred.make<void>();
        const resnapshot = yield* Deferred.make<void>();
        const sockets: NodeSocket.NodeWS.WebSocket[] = [];
        const originalWebSocket = globalThis.WebSocket;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            Object.defineProperty(globalThis, "WebSocket", {
              configurable: true,
              value: function WebSocket(socketUrl: string | URL, protocols?: string | string[]) {
                const socket = new NodeSocket.NodeWS.WebSocket(socketUrl, protocols);
                sockets.push(socket);
                return socket;
              },
            });
          }),
          () =>
            Effect.sync(() => {
              Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
              });
            }),
        );

        let wsTokenIssueCount = 0;
        let openCount = 0;
        const snapshots: number[] = [];
        const liveProjectSequences: number[] = [];
        const transport = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new WsTransport(
                async () => {
                  wsTokenIssueCount += 1;
                  return await Effect.runPromise(
                    resolveRemoteWebSocketConnectionUrl({
                      httpBaseUrl: registration.profile.httpBaseUrl,
                      wsBaseUrl: registration.profile.wsBaseUrl,
                      bearerToken: registration.credential.token,
                    }).pipe(Effect.provide(remoteHttpClientLayer(globalThis.fetch))),
                  );
                },
                {
                  onOpen: () => {
                    openCount += 1;
                    Effect.runFork(
                      Deferred.succeed(openCount === 1 ? opened : reconnected, undefined),
                    );
                  },
                  onClose: (_details, context) => {
                    if (!context.intentional) {
                      Effect.runFork(Deferred.succeed(disconnected, undefined));
                    }
                  },
                },
              ),
          ),
          (activeTransport) => Effect.promise(() => activeTransport.dispose()),
        );
        const unsubscribeLifecycle = transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
          (event) => {
            if (event.type === "ready") {
              Effect.runFork(Deferred.succeed(ready, undefined));
            }
          },
          { tag: WS_METHODS.subscribeServerLifecycle },
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeLifecycle));
        const unsubscribeShell = transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
          (item) => {
            if (item.kind === "project-upserted" && item.project.id === projectId) {
              liveProjectSequences.push(item.sequence);
              Effect.runFork(Deferred.succeed(liveProjectEvent, undefined));
              return;
            }
            if (item.kind !== "snapshot") {
              return;
            }
            snapshots.push(item.snapshot.snapshotSequence);
            const projectIds = item.snapshot.projects.map((project) => project.id);
            expect(new Set(projectIds).size).toBe(projectIds.length);
            Effect.runFork(
              Deferred.succeed(snapshots.length === 1 ? initialSnapshot : resnapshot, undefined),
            );
          },
          { tag: ORCHESTRATION_WS_METHODS.subscribeShell },
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeShell));

        yield* Deferred.await(opened).pipe(Effect.timeout("10 seconds"));
        yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
        yield* Deferred.await(initialSnapshot).pipe(Effect.timeout("10 seconds"));

        const dispatch = yield* fetchJson<{ readonly sequence: number }>(
          `${origin}/api/orchestration/dispatch`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${registration.credential.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              type: "project.create",
              commandId: CommandId.make("cmd-direct-connect-project-create"),
              projectId,
              title: "Direct Connect Project",
              workspaceRoot: workspaceDir,
              defaultModelSelection,
              createdAt: new Date().toISOString(),
            }),
          },
        );
        expect(dispatch.body.sequence).toBe(1);
        yield* Deferred.await(liveProjectEvent).pipe(Effect.timeout("10 seconds"));
        yield* retryUntil(
          fetchJson<{
            readonly snapshotSequence: number;
            readonly projects: ReadonlyArray<{ readonly title: string }>;
          }>(`${origin}/api/orchestration/shell-snapshot`, {
            headers: { authorization: `Bearer ${registration.credential.token}` },
          }),
          ({ body }) =>
            body.snapshotSequence === 1 &&
            body.projects.some((project) => project.title === "Direct Connect Project"),
          "the production projection to persist the project",
        );

        sockets[0]?.terminate();
        yield* Deferred.await(disconnected).pipe(Effect.timeout("10 seconds"));
        yield* Deferred.await(reconnected).pipe(Effect.timeout("10 seconds"));
        yield* Deferred.await(resnapshot).pipe(Effect.timeout("10 seconds"));
        expect(wsTokenIssueCount).toBeGreaterThanOrEqual(2);
        expect(snapshots).toEqual([0, 1]);
        expect(liveProjectSequences).toEqual([1]);

        const browserCredential = yield* createPairingCredential;
        const browser = yield* Effect.acquireRelease(
          Effect.promise(() => chromium.launch({ headless: true })),
          (instance) => Effect.promise(() => instance.close()),
        );
        const context = yield* Effect.acquireRelease(
          Effect.promise(() => browser.newContext()),
          (browserContext) => Effect.promise(() => browserContext.close()),
        );
        const page = yield* Effect.promise(() => context.newPage());
        let browserWebSocketCount = 0;
        page.on("websocket", (socket) => {
          if (new URL(socket.url()).pathname === "/ws") {
            browserWebSocketCount += 1;
          }
        });
        yield* Effect.promise(() =>
          page.goto(`${origin}/pair#token=${encodeURIComponent(browserCredential)}`),
        );
        yield* Effect.promise(() =>
          page.waitForURL((url) => url.pathname === "/" && url.hash === "", {
            timeout: 10_000,
          }),
        );
        yield* Effect.promise(() =>
          page.getByText("Direct Connect Project", { exact: true }).waitFor({
            state: "visible",
            timeout: 10_000,
          }),
        );
        const cookies = yield* Effect.promise(() => context.cookies(origin));
        expect(cookies.some((cookie) => cookie.name.startsWith("t3_session"))).toBe(true);
        expect(browserWebSocketCount).toBeGreaterThan(0);

        yield* Effect.promise(() => page.reload());
        yield* Effect.promise(() =>
          page.getByText("Direct Connect Project", { exact: true }).waitFor({
            state: "visible",
            timeout: 10_000,
          }),
        );
        const sessionResponse = yield* Effect.promise(() =>
          page.request.get(`${origin}/api/auth/session`),
        );
        expect(sessionResponse.status()).toBe(200);
        const sessionState = (yield* Effect.promise(() => sessionResponse.json())) as {
          readonly authenticated: boolean;
        };
        expect(sessionState).toMatchObject({ authenticated: true });

        unsubscribeShell();
        unsubscribeLifecycle();
        yield* Effect.promise(() => transport.dispose()).pipe(Effect.timeout("10 seconds"));
        yield* Effect.promise(() => context.close());
        yield* Effect.promise(() => browser.close());
        yield* Scope.close(serverScope, Exit.void);
        yield* retryUntil(
          readPersistedServerRuntimeState(config.serverRuntimeStatePath),
          Option.isNone,
          "production server shutdown cleanup",
        );
        const requestAfterShutdown = yield* Effect.exit(
          Effect.tryPromise({
            try: () => fetch(`${origin}/api/auth/session`),
            catch: (cause) =>
              new DirectConnectSmokeError({
                message: "Server shutdown request failed.",
                cause,
              }),
          }).pipe(Effect.timeout("5 seconds")),
        );
        expect(Exit.isFailure(requestAfterShutdown)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}, 120_000);
