// @effect-diagnostics nodeBuiltinImport:off - the bind failure is only real against an occupied TCP port.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServeError } from "effect/unstable/http/HttpServerError";

import * as ServerConfig from "./config.ts";
import { explainPortInUse } from "./portInUse.ts";
import { persistServerRuntimeState } from "./serverRuntimeState.ts";

const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-port-in-use-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** Holds a loopback port for the duration of the test scope. */
const occupyLoopbackPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => {
        resume(Effect.void);
      });
    }),
).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

const bindHttpServer = (port: number) =>
  Layer.launch(NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port }));

const configForPort = (port: number) =>
  Effect.map(ServerConfig.ServerConfig, (config) => ServerConfig.make({ ...config, port }));

it.effect("names the T3 server holding the port when server-runtime.json agrees", () =>
  Effect.gen(function* () {
    const port = yield* occupyLoopbackPort;
    const config = yield* configForPort(port);
    yield* persistServerRuntimeState({
      path: config.serverRuntimeStatePath,
      state: {
        version: 1,
        pid: 424242,
        port,
        origin: `http://127.0.0.1:${port}`,
        startedAt: "2026-08-20T13:29:55.900Z",
      },
    });

    const error = yield* explainPortInUse(bindHttpServer(port)).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.flip,
    );

    if (error._tag !== "PortInUseError") {
      return assert.fail(`Expected PortInUseError, got ${error._tag}`);
    }
    assert.strictEqual(error.holderPid, 424242);
    assert.strictEqual(
      error.message,
      `Port ${port} on 127.0.0.1 is already in use by a running T3 Code server (pid 424242 per server-runtime.json). Stop that server first; 't3 service status' finds it when it is the background service. If that pid is not actually a T3 server (stale descriptor, reused pid), delete '${config.serverRuntimeStatePath}' and retry.`,
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("names only the port when no server-runtime.json exists", () =>
  Effect.gen(function* () {
    const port = yield* occupyLoopbackPort;
    const config = yield* configForPort(port);

    const error = yield* explainPortInUse(bindHttpServer(port)).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "PortInUseError");
    assert.strictEqual(
      error.message,
      `Port ${port} on 127.0.0.1 is already in use. Stop whatever is listening there, or start T3 Code on another port with --port; 't3 service status' says whether the T3 Code background service is holding it.`,
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("claims no culprit when server-runtime.json describes another port", () =>
  Effect.gen(function* () {
    const port = yield* occupyLoopbackPort;
    const config = yield* configForPort(port);
    yield* persistServerRuntimeState({
      path: config.serverRuntimeStatePath,
      state: {
        version: 1,
        pid: 424242,
        port: port + 1,
        origin: `http://127.0.0.1:${port + 1}`,
        startedAt: "2026-08-20T13:29:55.900Z",
      },
    });

    const error = yield* explainPortInUse(bindHttpServer(port)).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "PortInUseError");
    assert.notInclude(error.message, "424242");
    assert.include(error.message, `Port ${port} on 127.0.0.1 is already in use.`);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("explains the EADDRINUSE defect Bun throws instead of failing", () =>
  Effect.gen(function* () {
    const config = yield* configForPort(3773);
    const defect = Object.assign(new Error("Failed to start server. Is port 3773 in use?"), {
      code: "EADDRINUSE",
    });

    const error = yield* explainPortInUse(Effect.die(defect)).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "PortInUseError");
    assert.include(error.message, "Port 3773 on 127.0.0.1 is already in use.");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("leaves other bind failures alone", () =>
  Effect.gen(function* () {
    const config = yield* configForPort(80);
    const serveError = new ServeError({
      cause: Object.assign(new Error("listen EACCES: permission denied 0.0.0.0:80"), {
        code: "EACCES",
      }),
    });

    const error = yield* explainPortInUse(Effect.fail(serveError)).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.flip,
    );

    assert.strictEqual(error, serveError);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
