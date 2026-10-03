import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { WsRpcGroup, WS_METHODS } from "@t3tools/contracts";
import { withRpcDeadlines } from "./rpcDeadline.ts";

import {
  CliRpcError,
  isDefinitiveCommandRejectionError,
  isDefinitiveCommandRejectionResponse,
  resolveLiveTarget,
  withBorrowedBearerToken,
  wsRpcProtocolLayer,
} from "./client.ts";

it.effect("provides a Node WebSocket constructor for the CLI RPC protocol", () =>
  Effect.scoped(
    Layer.build(wsRpcProtocolLayer("ws://127.0.0.1:3100/ws")).pipe(
      Effect.tap(() => Effect.sync(() => assert.isTrue(true))),
    ),
  ),
);

it.live("times out an open WebSocket whose unary response never arrives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeSocket.NodeWS.WebSocketServer>((resolve) => {
              const server: NodeSocket.NodeWS.WebSocketServer =
                new NodeSocket.NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 }, () =>
                  resolve(server),
                );
            }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const socket of server.clients) socket.terminate();
                server.close(() => resolve());
              }),
          ),
      );
      let requests = 0;
      server.on("connection", (socket) =>
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString());
          if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
          if (message._tag === "Request") requests++;
        }),
      );
      const address = server.address();
      if (!address || typeof address === "string") return yield* Effect.die("Expected TCP address");
      const result = yield* RpcClient.make(WsRpcGroup).pipe(
        Effect.map((client) => withRpcDeadlines(client, "1 second")),
        Effect.flatMap((client) => Effect.result(client[WS_METHODS.serverProbe]({}))),
        Effect.provide(wsRpcProtocolLayer(`ws://127.0.0.1:${address.port}/ws`)),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.include(String(result.failure), "CLI_RPC_TIMEOUT");
      assert.equal(requests, 1);
    }),
  ),
);

it.live("resolves a fresh account ticket on every CLI protocol reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeSocket.NodeWS.WebSocketServer>((resolve) => {
              const server: NodeSocket.NodeWS.WebSocketServer =
                new NodeSocket.NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 }, () =>
                  resolve(server),
                );
            }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const socket of server.clients) socket.terminate();
                server.close(() => resolve());
              }),
          ),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        return yield* Effect.die("Expected a TCP address");
      const urls: string[] = [];
      let closeFirst: (() => void) | undefined;
      server.on("connection", (socket, request) => {
        urls.push(request.url ?? "");
        if (urls.length === 1) closeFirst = () => socket.close(1012, "test reconnect");
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString());
          if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
          if (message._tag === "Request")
            socket.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: message.id,
                exit: { _tag: "Success", value: {} },
              }),
            );
        });
      });
      let ticket = 0;
      const nextUrl = Effect.sync(() => `ws://127.0.0.1:${address.port}/ws?wsTicket=${++ticket}`);
      yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        yield* client[WS_METHODS.serverProbe]({});
        closeFirst?.();
        while (urls.length < 2) yield* Effect.sleep("20 millis");
        assert.deepEqual(urls.slice(0, 2), ["/ws?wsTicket=1", "/ws?wsTicket=2"]);
      }).pipe(Effect.provide(wsRpcProtocolLayer(nextUrl)), Effect.timeout("5 seconds"));
    }),
  ),
);

it("only classifies structured invariant responses as definitive command rejections", () => {
  assert.isTrue(
    isDefinitiveCommandRejectionResponse(
      JSON.stringify({ error: "invariant failed", code: "command-rejected" }),
    ),
  );
  assert.isFalse(
    isDefinitiveCommandRejectionResponse(
      JSON.stringify({ error: "storage failed", code: "dispatch-failed" }),
    ),
  );
  assert.isFalse(isDefinitiveCommandRejectionResponse("<html>server unavailable</html>"));
});

it("preserves definitive command rejection as structured CLI error state", () => {
  assert.isTrue(
    isDefinitiveCommandRejectionError(
      new CliRpcError({
        message: "dispatch rejected",
        definitiveCommandRejection: true,
      }),
    ),
  );
  assert.isFalse(
    isDefinitiveCommandRejectionError(
      new CliRpcError({
        message: "ORCHESTRATION_COMMAND_REJECTED: appears only in diagnostics",
      }),
    ),
  );
});

it("reports malformed persisted runtime state with actionable recovery", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-invalid-runtime-state-"));
  const runtimeStatePath = join(baseDir, "userdata", "server-runtime.json");
  try {
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(runtimeStatePath, "not-json\n", "utf8");

    const error = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.some(baseDir),
        environment: Option.none(),
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );

    assert.include(error.message, runtimeStatePath);
    assert.include(error.message, "Remove it and restart T3");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("uses T3CODE_HOME for live commands when --base-dir is omitted", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-env-home-"));
  const runtimeStatePath = join(baseDir, "userdata", "server-runtime.json");
  const previousHome = process.env.T3CODE_HOME;
  try {
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 45_678,
        origin: "http://127.0.0.1:45678",
        startedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    process.env.T3CODE_HOME = baseDir;

    const target = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.none(),
        environment: Option.none(),
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    assert.equal(target.kind, "bearer");
    if (target.kind !== "bearer") throw new Error("Expected local bearer target.");
    assert.equal(target.baseDir, baseDir);
    assert.equal(target.origin, "http://127.0.0.1:45678");
  } finally {
    if (previousHome === undefined) {
      delete process.env.T3CODE_HOME;
    } else {
      process.env.T3CODE_HOME = previousHome;
    }
    await rm(baseDir, { recursive: true, force: true });
  }
});

const writeRuntimeState = async (
  baseDir: string,
  flavor: "userdata" | "dev",
  state: { readonly pid: number; readonly port: number },
) => {
  const stateDir = join(baseDir, flavor);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "server-runtime.json"),
    `${JSON.stringify({
      version: 1,
      pid: state.pid,
      port: state.port,
      origin: `http://127.0.0.1:${String(state.port)}`,
      startedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
};

it("discovers a running dev server through --base-dir", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-dev-runtime-state-"));
  try {
    await writeRuntimeState(baseDir, "dev", { pid: process.pid, port: 14_537 });

    const target = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.some(baseDir),
        environment: Option.none(),
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    assert.equal(target.kind, "bearer");
    if (target.kind !== "bearer") throw new Error("Expected local bearer target.");
    assert.equal(target.origin, "http://127.0.0.1:14537");
    assert.equal(target.baseDir, baseDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("falls back to a running dev server when the production runtime state is stale", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-dev-fallback-runtime-state-"));
  try {
    await writeRuntimeState(baseDir, "userdata", { pid: 4_194_305, port: 3_773 });
    await writeRuntimeState(baseDir, "dev", { pid: process.pid, port: 14_537 });

    const target = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.some(baseDir),
        environment: Option.none(),
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    assert.equal(target.kind, "bearer");
    if (target.kind !== "bearer") throw new Error("Expected local bearer target.");
    assert.equal(target.origin, "http://127.0.0.1:14537");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("prefers the production runtime state when both flavors are live", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-both-runtime-states-"));
  try {
    await writeRuntimeState(baseDir, "userdata", { pid: process.pid, port: 3_773 });
    await writeRuntimeState(baseDir, "dev", { pid: process.pid, port: 14_537 });

    const target = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.some(baseDir),
        environment: Option.none(),
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    assert.equal(target.kind, "bearer");
    if (target.kind !== "bearer") throw new Error("Expected local bearer target.");
    assert.equal(target.origin, "http://127.0.0.1:3773");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("lists both checked runtime state paths when no server is running", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-no-runtime-state-"));
  try {
    const error = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.some(baseDir),
        environment: Option.none(),
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );

    assert.include(error.message, "No running T3 server found.");
    assert.include(error.message, join(baseDir, "userdata", "server-runtime.json"));
    assert.include(error.message, join(baseDir, "dev", "server-runtime.json"));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("rejects persisted runtime state owned by a stopped process", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-stale-runtime-state-"));
  const runtimeStatePath = join(baseDir, "userdata", "server-runtime.json");
  try {
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        version: 1,
        pid: 4_194_305,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const error = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.some(baseDir),
        environment: Option.none(),
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );

    assert.include(error.message, "stopped process");
    assert.include(error.message, runtimeStatePath);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("uses a persisted manual environment before legacy local discovery", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-selected-env-"));
  const previousHome = process.env.T3CODE_HOME;
  try {
    await writeFile(
      join(baseDir, "cli-environments.json"),
      JSON.stringify({
        version: 2,
        current: { source: "manual", id: "windows" },
        environments: {
          windows: {
            id: "windows",
            label: "Windows",
            url: "https://windows.example.test/path",
            token: "remote-token",
          },
        },
      }),
    );
    process.env.T3CODE_HOME = baseDir;

    const target = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.none(),
        environment: Option.none(),
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    assert.equal(target.kind, "bearer");
    assert.equal(target.source, "manual");
    assert.equal(target.selectionReason, "persisted-selection");
    if (target.kind !== "bearer") throw new Error("Expected manual bearer target.");
    assert.equal(target.origin, "https://windows.example.test");
  } finally {
    if (previousHome === undefined) {
      delete process.env.T3CODE_HOME;
    } else {
      process.env.T3CODE_HOME = previousHome;
    }
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("preserves an explicit registry base for tokenless manual environment authentication", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-tokenless-manual-env-"));
  try {
    await writeFile(
      join(baseDir, "cli-environments.json"),
      JSON.stringify({
        version: 2,
        environments: {
          local: {
            id: "local",
            label: "Local",
            url: "http://127.0.0.1:45678",
          },
        },
      }),
    );

    const target = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.none(),
        environment: Option.some("manual:local"),
        registryBaseDir: Option.some(baseDir),
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    assert.equal(target.kind, "bearer");
    if (target.kind !== "bearer") throw new Error("Expected manual bearer target.");
    assert.equal(target.source, "manual");
    assert.equal(target.baseDir, baseDir);
    assert.isUndefined(target.token);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("refuses to send a borrowed local credential to a different manual origin", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-tokenless-origin-mismatch-"));
  try {
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(
      join(baseDir, "userdata", "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 45_678,
        origin: "http://127.0.0.1:45678",
        startedAt: new Date().toISOString(),
      }),
    );
    await writeFile(
      join(baseDir, "cli-environments.json"),
      JSON.stringify({
        version: 2,
        environments: {
          remote: {
            id: "remote",
            label: "Remote",
            url: "https://remote.example.test",
          },
        },
      }),
    );

    const error = await Effect.runPromise(
      withBorrowedBearerToken(
        {
          url: Option.none(),
          token: Option.none(),
          baseDir: Option.none(),
          environment: Option.some("manual:remote"),
          registryBaseDir: Option.some(baseDir),
        },
        () => Effect.die("Borrowed credential must not reach a different origin."),
      ).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );

    assert.include(error.message, "Refusing to send a credential");
    assert.include(error.message, "http://127.0.0.1:45678");
    assert.include(error.message, "https://remote.example.test");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("keeps explicit base-dir authoritative over selected and one-shot environments", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-explicit-base-dir-"));
  const runtimeStatePath = join(baseDir, "userdata", "server-runtime.json");
  try {
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 45_679,
        origin: "http://127.0.0.1:45679",
        startedAt: new Date().toISOString(),
      }),
    );
    await writeFile(
      join(baseDir, "cli-environments.json"),
      JSON.stringify({
        version: 2,
        current: { source: "manual", id: "remote" },
        environments: {
          remote: {
            id: "remote",
            label: "Remote",
            url: "https://remote.example.test",
            token: "remote-token",
          },
        },
      }),
    );

    const target = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.some(baseDir),
        environment: Option.some("remote"),
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    assert.equal(target.kind, "bearer");
    assert.equal(target.source, "explicit-base-dir");
    assert.equal(target.selectionReason, "--base-dir");
    if (target.kind !== "bearer") throw new Error("Expected local bearer target.");
    assert.equal(target.origin, "http://127.0.0.1:45679");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("does not fall back to local discovery when a selected environment is invalid", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-selected-missing-"));
  const previousHome = process.env.T3CODE_HOME;
  try {
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(
      join(baseDir, "userdata", "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 45_680,
        origin: "http://127.0.0.1:45680",
        startedAt: new Date().toISOString(),
      }),
    );
    await writeFile(
      join(baseDir, "cli-environments.json"),
      JSON.stringify({
        version: 2,
        current: { source: "manual", id: "removed" },
        environments: {},
      }),
    );
    process.env.T3CODE_HOME = baseDir;

    const error = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.none(),
        environment: Option.none(),
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );

    assert.include(error.message, "no longer exists");
  } finally {
    if (previousHome === undefined) {
      delete process.env.T3CODE_HOME;
    } else {
      process.env.T3CODE_HOME = previousHome;
    }
    await rm(baseDir, { recursive: true, force: true });
  }
});
