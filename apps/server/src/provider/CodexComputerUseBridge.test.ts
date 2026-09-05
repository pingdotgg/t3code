// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  COMPUTER_USE_SHIM_SHA256,
  COMPUTER_USE_SHIM_SOURCE,
  findComputerUseHelper,
  makeCodexComputerUseBridge,
  materializeComputerUseShim,
} from "./CodexComputerUseBridge.ts";

interface ShimPipeRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
  readonly meta: Record<string, unknown>;
}

interface ShimElicitation {
  readonly message: string;
  readonly meta: Record<string, unknown>;
}

interface ShimSky {
  readonly list_apps: () => Promise<unknown>;
  readonly get_window_state: (input: {
    readonly window: { readonly id: number };
    readonly include_screenshot: boolean;
    readonly include_text: boolean;
  }) => Promise<unknown>;
}

let shimImportId = 0;

interface ExecutableShimOptions {
  readonly requireApproval: boolean;
  readonly approvalPersistence?: "session" | "always";
  readonly failedConnectionAttempts?: number;
  readonly dropFirstRequestWithPartialResponse?: boolean;
  readonly closePreviousConnectionOnSecondRequest?: boolean;
}

async function withExecutableShim(
  options: ExecutableShimOptions,
  run: (context: {
    readonly sky: ShimSky;
    readonly requests: ReadonlyArray<ShimPipeRequest>;
    readonly elicitations: ReadonlyArray<ShimElicitation>;
    readonly connectionAttempts: () => number;
    readonly closeConnection: (index: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const previousNodeRepl = Object.getOwnPropertyDescriptor(globalThis, "nodeRepl");
  const previousPipePath = process.env.T3_CODEX_COMPUTER_USE_PIPE_PATH;
  const requests: ShimPipeRequest[] = [];
  const elicitations: ShimElicitation[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let connectionAttempts = 0;
  const connections: Array<{ readonly close: () => void }> = [];
  const makeConnection = () => {
    const connectionIndex = connections.length;
    let onData: ((chunk: Uint8Array) => void) | undefined;
    let onClose: (() => void) | undefined;
    const connection = {
      on(event: string, listener: (value: Uint8Array) => void) {
        if (event === "data") onData = listener;
        if (event === "close") onClose = listener as () => void;
        return connection;
      },
      write(chunk: Uint8Array) {
        const request = JSON.parse(decoder.decode(chunk)) as ShimPipeRequest;
        requests.push(request);
        if (
          options.closePreviousConnectionOnSecondRequest === true &&
          connectionIndex === 1 &&
          requests.length === 2
        ) {
          connections[0]?.close();
        }
        if (options.dropFirstRequestWithPartialResponse === true && requests.length === 1) {
          queueMicrotask(() => {
            onData?.(encoder.encode('{"id":'));
            onClose?.();
          });
          return true;
        }
        const approved = request.meta["x-oai-cua-approved-app"] === "t3code.exe";
        const response =
          options.requireApproval && !approved
            ? {
                id: request.id,
                ok: false,
                approvalRequest: {
                  app: "t3code.exe",
                  displayName: "T3 Code",
                  riskLevel: "low",
                },
              }
            : {
                id: request.id,
                ok: true,
                result: options.requireApproval
                  ? { screenshots: [], text: "approved" }
                  : [{ name: "T3 Code" }],
              };
        queueMicrotask(() => onData?.(encoder.encode(`${JSON.stringify(response)}\n`)));
        return true;
      },
    };
    connections.push({ close: () => onClose?.() });
    return connection;
  };

  Object.defineProperty(globalThis, "nodeRepl", {
    configurable: true,
    value: {
      requestMeta: { session_id: "session-1", turn_id: "turn-1" },
      nativePipe: {
        createConnection: async () => {
          connectionAttempts += 1;
          if (connectionAttempts <= (options.failedConnectionAttempts ?? 0)) {
            throw new Error("Computer Use pipe is not ready");
          }
          return makeConnection();
        },
      },
      createElicitation: async (request: ShimElicitation) => {
        elicitations.push(request);
        return {
          action: "accept",
          _meta: { persist: options.approvalPersistence ?? "session" },
        };
      },
      emitImage: async () => undefined,
    },
  });
  process.env.T3_CODEX_COMPUTER_USE_PIPE_PATH = "\\\\.\\pipe\\t3code-cua-test";

  try {
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(COMPUTER_USE_SHIM_SOURCE).toString("base64")}#executable-shim-${++shimImportId}`;
    const loaded = (await import(moduleUrl)) as unknown as { readonly sky: ShimSky };
    await run({
      sky: loaded.sky,
      requests,
      elicitations,
      connectionAttempts: () => connectionAttempts,
      closeConnection: (index) => connections[index]?.close(),
    });
  } finally {
    if (previousNodeRepl) {
      Object.defineProperty(globalThis, "nodeRepl", previousNodeRepl);
    } else {
      Reflect.deleteProperty(globalThis, "nodeRepl");
    }
    if (previousPipePath === undefined) {
      delete process.env.T3_CODEX_COMPUTER_USE_PIPE_PATH;
    } else {
      process.env.T3_CODEX_COMPUTER_USE_PIPE_PATH = previousPipePath;
    }
  }
}

function makeHelperSpawner(control: {
  readonly commands: Array<ChildProcess.Command>;
  killCount: number;
}) {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      control.commands.push(command);
      const output = yield* Queue.unbounded<Uint8Array>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let receiveBuffer = "";
      let killed = false;

      const kill = () =>
        Effect.gen(function* () {
          if (killed) return;
          killed = true;
          control.killCount += 1;
          yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
          yield* Queue.shutdown(output);
        });
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1234),
        exitCode: Deferred.await(exited),
        isRunning: Effect.sync(() => !killed),
        kill,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          receiveBuffer += decoder.decode(chunk, { stream: true });
          const responses: Uint8Array[] = [];
          for (;;) {
            const newline = receiveBuffer.indexOf("\n");
            if (newline < 0) break;
            const line = receiveBuffer.slice(0, newline).trim();
            receiveBuffer = receiveBuffer.slice(newline + 1);
            if (!line) continue;
            const request = JSON.parse(line) as ShimPipeRequest;
            responses.push(
              encoder.encode(
                `${JSON.stringify({ id: request.id, ok: true, result: [{ name: "T3 Code" }] })}\n`,
              ),
            );
          }
          return Effect.forEach(responses, (response) => Queue.offer(output, response), {
            discard: true,
          });
        }),
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });

      return yield* Effect.acquireRelease(Effect.succeed(handle), kill);
    }),
  );
}

function requestNamedPipe(pipePath: string): Promise<{
  readonly response: unknown;
  readonly closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(pipePath);
    const decoder = new TextDecoder();
    let receiveBuffer = "";
    const closed = new Promise<void>((resolveClosed) => socket.once("close", resolveClosed));
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "list_apps", params: {}, meta: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      receiveBuffer += decoder.decode(chunk, { stream: true });
      const newline = receiveBuffer.indexOf("\n");
      if (newline < 0) return;
      resolve({ response: JSON.parse(receiveBuffer.slice(0, newline)), closed });
    });
  });
}

function connectNamedPipe(pipePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(pipePath);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

describe("CodexComputerUseBridge", () => {
  it("routes list_apps through the trusted native-pipe shim", () =>
    withExecutableShim({ requireApproval: false }, async ({ sky, requests }) => {
      NodeAssert.deepStrictEqual(await sky.list_apps(), [{ name: "T3 Code" }]);
      NodeAssert.deepStrictEqual(requests, [
        {
          id: 1,
          method: "list_apps",
          params: {},
          meta: {
            session_id: "session-1",
            turn_id: "turn-1",
          },
        },
      ]);
    }));

  it("requests approval and retries the same helper call with approval metadata", () =>
    withExecutableShim({ requireApproval: true }, async ({ sky, requests, elicitations }) => {
      NodeAssert.deepStrictEqual(
        await sky.get_window_state({
          window: { id: 7 },
          include_screenshot: false,
          include_text: true,
        }),
        { screenshots: [], text: "approved" },
      );
      NodeAssert.deepStrictEqual(elicitations, [
        {
          message: "Allow Codex to use T3 Code?",
          meta: {
            codex_approval_kind: "mcp_tool_call",
            connector_id: "computer-use",
            connector_name: "Computer Use",
            persist: ["session", "always"],
            riskLevel: "low",
            tool_params: { app: "t3code.exe" },
            tool_params_display: [{ name: "app", display_name: "App", value: "T3 Code" }],
          },
        },
      ]);
      NodeAssert.equal(requests.length, 2);
      NodeAssert.equal(requests[0]?.method, "get_window_state");
      NodeAssert.deepStrictEqual(requests[1]?.params, requests[0]?.params);
      NodeAssert.equal(requests[0]?.meta["x-oai-cua-approved-app"], undefined);
      NodeAssert.equal(requests[1]?.meta["x-oai-cua-approved-app"], "t3code.exe");
    }));

  it("retries the native pipe connection after an initial failure", () =>
    withExecutableShim(
      { requireApproval: false, failedConnectionAttempts: 1 },
      async ({ sky, requests, connectionAttempts }) => {
        await NodeAssert.rejects(sky.list_apps(), /Computer Use pipe is not ready/);
        NodeAssert.deepStrictEqual(await sky.list_apps(), [{ name: "T3 Code" }]);
        NodeAssert.equal(connectionAttempts(), 2);
        NodeAssert.equal(requests.length, 1);
      },
    ));

  it("discards partial responses when reconnecting", () =>
    withExecutableShim(
      { requireApproval: false, dropFirstRequestWithPartialResponse: true },
      async ({ sky, requests, connectionAttempts }) => {
        await NodeAssert.rejects(sky.list_apps(), /Computer Use pipe closed/);
        NodeAssert.deepStrictEqual(await sky.list_apps(), [{ name: "T3 Code" }]);
        NodeAssert.equal(connectionAttempts(), 2);
        NodeAssert.equal(requests.length, 2);
      },
    ));

  it("ignores a stale close event after reconnecting", () =>
    withExecutableShim(
      { requireApproval: false, closePreviousConnectionOnSecondRequest: true },
      async ({ sky, connectionAttempts, closeConnection }) => {
        NodeAssert.deepStrictEqual(await sky.list_apps(), [{ name: "T3 Code" }]);
        closeConnection(0);
        NodeAssert.deepStrictEqual(await sky.list_apps(), [{ name: "T3 Code" }]);
        NodeAssert.equal(connectionAttempts(), 2);
      },
    ));

  it("remembers always-allow approval for later calls", () =>
    withExecutableShim(
      { requireApproval: true, approvalPersistence: "always" },
      async ({ sky, requests, elicitations }) => {
        const input = {
          window: { id: 7 },
          include_screenshot: false,
          include_text: true,
        };
        await sky.get_window_state(input);
        await sky.get_window_state(input);

        NodeAssert.equal(elicitations.length, 1);
        NodeAssert.equal(requests.length, 4);
        NodeAssert.equal(requests[1]?.meta["x-oai-cua-approved-app"], "t3code.exe");
        NodeAssert.equal(requests[3]?.meta["x-oai-cua-approved-app"], "t3code.exe");
      },
    ));

  it("pins trust to the exact embedded shim bytes", () => {
    NodeAssert.equal(
      COMPUTER_USE_SHIM_SHA256,
      NodeCrypto.createHash("sha256").update(COMPUTER_USE_SHIM_SOURCE).digest("hex"),
    );
    NodeAssert.doesNotMatch(COMPUTER_USE_SHIM_SOURCE, /^import\s/m);
    NodeAssert.match(COMPUTER_USE_SHIM_SOURCE, /Object\.freeze\(sky\)/);
  });

  it.effect("materializes a content-addressed package", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cua-shim-"))),
      (codexHome) =>
        Effect.gen(function* () {
          const first = yield* materializeComputerUseShim(codexHome);
          const second = yield* materializeComputerUseShim(codexHome);
          NodeAssert.deepStrictEqual(second, first);
          NodeAssert.equal(
            yield* Effect.promise(() => NodeFSP.readFile(first.entryPath, "utf8")),
            COMPUTER_USE_SHIM_SOURCE,
          );
        }),
      (codexHome) => Effect.promise(() => NodeFSP.rm(codexHome, { recursive: true, force: true })),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("proxies a named-pipe request and closes the scoped helper", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cua-bridge-"))),
      (root) =>
        Effect.gen(function* () {
          const nodeModulesRoot = NodePath.join(root, "node_modules");
          const helperPath = NodePath.join(
            nodeModulesRoot,
            "@oai",
            "sky",
            "bin",
            "windows",
            "codex-computer-use.exe",
          );
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.dirname(helperPath), { recursive: true }),
          );
          yield* Effect.promise(() => NodeFSP.writeFile(helperPath, "helper", "utf8"));

          const control = {
            commands: [] as Array<ChildProcess.Command>,
            killCount: 0,
          };
          const spawner = makeHelperSpawner(control);
          const exchange = yield* Effect.scoped(
            Effect.gen(function* () {
              const config = yield* makeCodexComputerUseBridge({
                codexHome: NodePath.join(root, "codex-home"),
                nodeModuleRoots: [nodeModulesRoot],
              }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.provideService(
                  HostProcessPlatform,
                  NodePath.sep === "\\" ? "win32" : "linux",
                ),
                Effect.provide(NodeServices.layer),
              );
              NodeAssert.ok(config);

              const request = yield* Effect.promise(() => requestNamedPipe(config.pipePath));
              return { ...request, pipePath: config.pipePath };
            }),
          );

          NodeAssert.deepStrictEqual(exchange.response, {
            id: 1,
            ok: true,
            result: [{ name: "T3 Code" }],
          });
          NodeAssert.equal(control.commands.length, 1);
          const command = control.commands[0];
          NodeAssert.equal(command?._tag, "StandardCommand");
          if (command?._tag === "StandardCommand") {
            NodeAssert.equal(command.command, helperPath);
            NodeAssert.deepStrictEqual(command.args, ["--parent-pid", String(process.pid)]);
            NodeAssert.equal(command.options.stderr, "ignore");
          }
          yield* Effect.promise(() => exchange.closed);
          NodeAssert.equal(control.killCount, 1);
          yield* Effect.promise(() => NodeAssert.rejects(connectNamedPipe(exchange.pipePath)));
        }),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    ),
  );

  it.effect("locates the helper under configured node module roots", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cua-helper-"))),
      (root) =>
        Effect.gen(function* () {
          const helperPath = NodePath.join(
            root,
            "@oai",
            "sky",
            "bin",
            "windows",
            "codex-computer-use.exe",
          );
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.dirname(helperPath), { recursive: true }),
          );
          yield* Effect.promise(() => NodeFSP.writeFile(helperPath, "helper", "utf8"));

          NodeAssert.equal(
            yield* findComputerUseHelper([NodePath.join(root, "missing"), root]),
            helperPath,
          );
        }),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
