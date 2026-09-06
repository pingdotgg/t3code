import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as NodeSink from "@effect/platform-node/NodeSink";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const COMPUTER_USE_HELPER_PATH_SEGMENTS = [
  "@oai",
  "sky",
  "bin",
  "windows",
  "codex-computer-use.exe",
] as const;
const COMPUTER_USE_SHIM_PACKAGE_JSON = `${JSON.stringify({
  name: "@oai/sky",
  private: true,
  type: "module",
  exports: "./index.js",
})}\n`;
// Codex trusts this module by its exact SHA-256. Keep it self-contained so
// importing the shim does not expand the trusted module graph.
export const COMPUTER_USE_SHIM_SOURCE = String.raw`const nodeRepl = globalThis.nodeRepl;
const processShim = globalThis.process;
const pipePath = processShim?.env?.T3_CODEX_COMPUTER_USE_PIPE_PATH;
if (!nodeRepl?.nativePipe || typeof nodeRepl.nativePipe.createConnection !== "function") {
  throw new Error("T3 Computer Use trusted native-pipe bridge is unavailable");
}
if (typeof pipePath !== "string" || !pipePath.startsWith("\\\\.\\pipe\\t3code-cua-")) {
  throw new Error("T3 Computer Use pipe configuration is unavailable");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const pending = new Map();
const sessionApprovedScopes = new Set();
let connectionPromise;
let receiveBuffer = "";
let nextRequestId = 1;
let activeTurnKey = null;
let activeTurnMetadata = null;

const sanitizeError = (value) => {
  const text = value && typeof value.message === "string" ? value.message : String(value);
  return text.slice(0, 2000);
};

const inertClone = (value, label) => {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(label + " must be JSON-serializable");
  }
  if (typeof encoded !== "string" || encoded.length > 16 * 1024 * 1024) {
    throw new TypeError(label + " is too large");
  }
  return JSON.parse(encoded);
};

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const currentTurnMetadata = () => {
  const merged = Object.create(null);
  const merge = (candidate) => {
    let value = candidate;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { value = null; }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, entry] of Object.entries(value)) merged[key] = entry;
    }
  };
  merge(processShim?.env?.NODE_REPL_REQUEST_META);
  merge(nodeRepl.requestMeta);
  const nested = merged["x-codex-turn-metadata"];
  delete merged["x-codex-turn-metadata"];
  merge(nested);
  delete merged["x-oai-cua-approved-app"];
  return inertClone(merged, "Computer Use turn metadata");
};

const turnKey = (metadata) => {
  const sessionId = typeof metadata.session_id === "string" ? metadata.session_id : "";
  const turnId = typeof metadata.turn_id === "string" ? metadata.turn_id : "";
  return sessionId && turnId ? sessionId + "\u0000" + turnId : null;
};

const approvalScopeKey = (sessionId, app, method, params) => {
  const windowTarget =
    params && typeof params === "object" && !Array.isArray(params) ? params.window : undefined;
  if (windowTarget && typeof windowTarget === "object" && !Array.isArray(windowTarget)) {
    const windowId = windowTarget.id;
    return JSON.stringify(
      typeof windowId === "number" || typeof windowId === "string"
        ? { sessionId, app, windowId }
        : { sessionId, app, window: windowTarget },
    );
  }
  return JSON.stringify({ sessionId, app, method, params });
};

const handleLine = (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message.id !== "number") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timeout);
  waiter.resolve(message);
};

const getConnection = async () => {
  if (!connectionPromise) {
    const candidate = nodeRepl.nativePipe
      .createConnection(pipePath)
      .then((connection) => {
        connection.on("data", (chunk) => {
          receiveBuffer += decoder.decode(chunk, { stream: true });
          for (;;) {
            const newline = receiveBuffer.indexOf("\n");
            if (newline < 0) break;
            const line = receiveBuffer.slice(0, newline).trim();
            receiveBuffer = receiveBuffer.slice(newline + 1);
            if (line) handleLine(line);
          }
        });
        const rejectAll = (reason) => {
          if (connectionPromise !== candidate) return;
          const message = sanitizeError(reason || "Computer Use pipe closed");
          connectionPromise = undefined;
          receiveBuffer = "";
          for (const waiter of pending.values()) {
            clearTimeout(waiter.timeout);
            waiter.reject(new Error(message));
          }
          pending.clear();
        };
        connection.on("error", rejectAll);
        connection.on("close", () => rejectAll("Computer Use pipe closed"));
        return connection;
      })
      .catch((error) => {
        if (connectionPromise === candidate) connectionPromise = undefined;
        throw error;
      });
    connectionPromise = candidate;
  }
  return connectionPromise;
};

const send = async (method, params, metadata) => {
  const connection = await getConnection();
  const id = nextRequestId++;
  const request = JSON.stringify({ id, method, params, meta: metadata }) + "\n";
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Computer Use request timed out: " + method));
    }, method === "launch_app" ? 15000 : 10000);
    pending.set(id, { resolve, reject, timeout });
  });
  try {
    connection.write(encoder.encode(request));
  } catch (error) {
    const waiter = pending.get(id);
    if (waiter) clearTimeout(waiter.timeout);
    pending.delete(id);
    throw error;
  }
  return response;
};

const invoke = async (method, rawParams) => {
  const params = inertClone(rawParams ?? {}, "Computer Use input");
  const metadata = currentTurnMetadata();
  const nextTurnKey = turnKey(metadata);
  if (activeTurnKey && activeTurnKey !== nextTurnKey) {
    try { await send("end_turn", {}, activeTurnMetadata ?? {}); } catch {}
  }
  activeTurnKey = nextTurnKey;
  activeTurnMetadata = metadata;

  let response = await send(method, params, metadata);
  if (response?.ok !== true && response?.approvalRequest) {
    const request = response.approvalRequest;
    const app = typeof request.app === "string" ? request.app.trim() : "";
    const displayName =
      typeof request.displayName === "string" && request.displayName.trim()
        ? request.displayName.trim()
        : app;
    if (!app) throw new Error("Computer Use returned an invalid approval request");
    const approvalScope = approvalScopeKey(metadata.session_id ?? null, app, method, params);

    if (!sessionApprovedScopes.has(approvalScope)) {
      const createElicitation = nodeRepl.createElicitation;
      if (typeof createElicitation !== "function") {
        throw new Error("Computer Use requires app approval but elicitations are unavailable");
      }
      const decision = await createElicitation({
        message: "Allow Codex to use " + displayName + "?",
        meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_id: "computer-use",
          connector_name: "Computer Use",
          persist: ["session", "always"],
          riskLevel: request.riskLevel === "high" ? "high" : "low",
          tool_params: { app },
          tool_params_display: [{ name: "app", display_name: "App", value: displayName }],
        },
      });
      if (decision?.action !== "accept") {
        throw new Error("Computer Use was not approved to use " + displayName);
      }
      if (
        decision?._meta?.persist === "session" ||
        decision?._meta?.persist === "always"
      ) {
        sessionApprovedScopes.add(approvalScope);
      }
    }

    const approvedMetadata = inertClone(metadata, "Computer Use metadata");
    approvedMetadata["x-oai-cua-approved-app"] = app;
    response = await send(method, params, approvedMetadata);
  }

  if (response?.ok !== true) {
    throw new Error(
      typeof response?.error === "string"
        ? response.error.slice(0, 2000)
        : "Computer Use request failed",
    );
  }
  const result = inertClone(response.result ?? null, "Computer Use result");
  if (method === "get_window_state" && Array.isArray(result?.screenshots)) {
    for (const screenshot of result.screenshots) {
      if (typeof screenshot?.url === "string") await nodeRepl.emitImage(screenshot.url);
    }
  }
  return deepFreeze(result);
};

const requireRecord = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be an object");
  }
  return value;
};

const method = (name, map = (value) => requireRecord(value, name + " input")) =>
  Object.freeze(async (value) => invoke(name, map(value)));
const noInputMethod = (name) => Object.freeze(async () => invoke(name, {}));

const sky = Object.assign(Object.create(null), {
  list_windows: noInputMethod("list_windows"),
  list_apps: noInputMethod("list_apps"),
  get_window: method("get_window"),
  activate_window: method("activate_window"),
  get_window_state: method("get_window_state", (value) => {
    const input = requireRecord(value, "get_window_state input");
    return {
      window: input.window,
      include_screenshot: input.include_screenshot !== false,
      include_text: input.include_text === true,
    };
  }),
  click: Object.freeze(async (value) => {
    const input = requireRecord(value, "click input");
    const element = input.element_index ?? input.elementIndex ?? input.element;
    if (element !== undefined) {
      return invoke("click_element", {
        window: input.window,
        element_index: element,
        click_count: input.click_count ?? 1,
        mouse_button: input.mouse_button ?? "left",
      });
    }
    return invoke("click", {
      window: input.window,
      x: input.x,
      y: input.y,
      screenshotId: input.screenshotId,
      click_count: input.click_count ?? 1,
      mouse_button: input.mouse_button ?? "left",
    });
  }),
  scroll: method("scroll"),
  drag: method("drag"),
  press_key: method("press_key"),
  type_text: method("type_text"),
  launch_app: method("launch_app"),
  perform_secondary_action: method("perform_secondary_action"),
  set_value: method("set_value"),
});
Object.freeze(sky);
export { sky };
`;

export const COMPUTER_USE_SHIM_SHA256 = NodeCrypto.createHash("sha256")
  .update(COMPUTER_USE_SHIM_SOURCE)
  .digest("hex");

// The native pipe capability is available only to SHA-pinned trusted modules.
// If the node_repl sandbox ever exposes raw pipe access, this bridge will also
// need to authenticate clients before forwarding requests to the helper.
export interface CodexComputerUseBridgeConfig {
  readonly nodeModulesRoot: string;
  readonly trustedModuleSha256: string;
  readonly pipePath: string;
}

export interface CodexComputerUseBridgeInput {
  readonly codexHome: string;
  readonly nodeModuleRoots: ReadonlyArray<string>;
}

export class CodexComputerUseBridgeError extends Schema.TaggedErrorClass<CodexComputerUseBridgeError>()(
  "CodexComputerUseBridgeError",
  {
    operation: Schema.Literals(["listen", "read", "write"]),
    pipePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the T3 Computer Use bridge pipe at '${this.pipePath}'.`;
  }
}

export class ComputerUseShimFileSystemError extends Schema.TaggedErrorClass<ComputerUseShimFileSystemError>()(
  "ComputerUseShimFileSystemError",
  {
    operation: Schema.Literals(["makeDirectory", "read", "write", "link"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the T3 Computer Use shim at '${this.path}'.`;
  }
}

export class ComputerUseShimMismatchError extends Schema.TaggedErrorClass<ComputerUseShimMismatchError>()(
  "ComputerUseShimMismatchError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Refusing to use mismatched Computer Use shim at '${this.path}'.`;
  }
}

export const findComputerUseHelper = Effect.fn("findComputerUseHelper")(function* (
  nodeModuleRoots: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const root of nodeModuleRoots) {
    const candidate = path.join(root, ...COMPUTER_USE_HELPER_PATH_SEGMENTS);
    const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File") return candidate;
  }
  return undefined;
});

const writeFileExactly = Effect.fn("writeFileExactly")(function* (
  filePath: string,
  content: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const existing = yield* fileSystem.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : new ComputerUseShimFileSystemError({
              operation: "read",
              path: filePath,
              cause,
            }),
    }),
  );
  if (Option.isSome(existing)) {
    if (existing.value !== content) {
      return yield* new ComputerUseShimMismatchError({ path: filePath });
    }
    return;
  }

  const temporaryPath = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  yield* fileSystem.writeFileString(temporaryPath, content, { flag: "wx" }).pipe(
    Effect.mapError(
      (cause) =>
        new ComputerUseShimFileSystemError({
          operation: "write",
          path: temporaryPath,
          cause,
        }),
    ),
  );
  yield* fileSystem.link(temporaryPath, filePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag !== "AlreadyExists") {
          return new ComputerUseShimFileSystemError({
            operation: "link",
            path: filePath,
            cause,
          });
        }
        return fileSystem.readFileString(filePath).pipe(
          Effect.mapError(
            (readCause) =>
              new ComputerUseShimFileSystemError({
                operation: "read",
                path: filePath,
                cause: readCause,
              }),
          ),
          Effect.flatMap((current) =>
            current === content
              ? Effect.void
              : new ComputerUseShimMismatchError({ path: filePath }),
          ),
        );
      },
    }),
    Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
  );
});

export const materializeComputerUseShim = Effect.fn("materializeComputerUseShim")(function* (
  codexHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nodeModulesRoot = path.join(
    codexHome,
    "cache",
    "t3-code",
    "cua-shim",
    COMPUTER_USE_SHIM_SHA256,
    "node_modules",
  );
  const packageDirectory = path.join(nodeModulesRoot, "@oai", "sky");
  yield* fileSystem.makeDirectory(packageDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ComputerUseShimFileSystemError({
          operation: "makeDirectory",
          path: packageDirectory,
          cause,
        }),
    ),
  );
  const entryPath = path.join(packageDirectory, "index.js");
  yield* writeFileExactly(entryPath, COMPUTER_USE_SHIM_SOURCE);
  yield* writeFileExactly(
    path.join(packageDirectory, "package.json"),
    COMPUTER_USE_SHIM_PACKAGE_JSON,
  );
  return { nodeModulesRoot, entryPath };
});

function listenNamedPipe(
  server: NodeNet.Server,
  pipePath: string,
): Effect.Effect<void, CodexComputerUseBridgeError> {
  return Effect.callback<void, CodexComputerUseBridgeError>((resume) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      resume(
        Effect.fail(new CodexComputerUseBridgeError({ operation: "listen", pipePath, cause })),
      );
    };
    const onListening = () => {
      server.off("error", onError);
      resume(Effect.void);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(pipePath);
    return Effect.sync(() => {
      server.off("error", onError);
      server.off("listening", onListening);
    });
  });
}

const shutdownNamedPipe = Effect.fn("shutdownNamedPipe")(function* (
  server: NodeNet.Server,
  sockets: Set<NodeNet.Socket>,
  connectionScope: Scope.Scope,
) {
  const serverClosed = yield* Deferred.make<void>();
  yield* Effect.sync(() => {
    try {
      server.close(() => Deferred.doneUnsafe(serverClosed, Effect.void));
    } catch {
      Deferred.doneUnsafe(serverClosed, Effect.void);
    }
    for (const socket of sockets) socket.destroy();
  });
  yield* Scope.close(connectionScope, Exit.void);
  yield* Deferred.await(serverClosed);
});

export const makeCodexComputerUseBridge = Effect.fn("makeCodexComputerUseBridge")(function* (
  input: CodexComputerUseBridgeInput,
) {
  const helperPath = yield* findComputerUseHelper(input.nodeModuleRoots);
  if (!helperPath) return undefined;

  const shim = yield* materializeComputerUseShim(input.codexHome);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;
  const pipeId = NodeCrypto.randomUUID();
  const pipePath =
    hostPlatform === "win32"
      ? `\\\\.\\pipe\\t3code-cua-${pipeId}`
      : `${NodeOS.tmpdir().replace(/[\\/]+$/, "")}/t3code-cua-${pipeId}.sock`;
  const sockets = new Set<NodeNet.Socket>();
  const connectionScope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const runConnection = yield* FiberSet.makeRuntime<never, void, never>().pipe(
    Effect.provideService(Scope.Scope, connectionScope),
  );
  const runBridgeTask = yield* FiberSet.makeRuntime<never, void, never>();

  const handleConnection = Effect.fn("CodexComputerUseBridge.handleConnection")(function* (
    socket: NodeNet.Socket,
  ) {
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.sync(() => {
        sockets.delete(socket);
        if (!socket.destroyed) socket.destroy();
      }),
    );

    const helper = yield* spawner.spawn(
      ChildProcess.make(helperPath, ["--parent-pid", String(process.pid)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        forceKillAfter: "2 seconds",
      }),
    );
    const socketInput = NodeStream.fromReadable<Uint8Array, CodexComputerUseBridgeError>({
      evaluate: () => socket,
      closeOnDone: false,
      onError: (cause) => new CodexComputerUseBridgeError({ operation: "read", pipePath, cause }),
    });
    const socketOutput = NodeSink.fromWritable<CodexComputerUseBridgeError>({
      evaluate: () => socket,
      endOnDone: false,
      onError: (cause) => new CodexComputerUseBridgeError({ operation: "write", pipePath, cause }),
    });

    yield* Effect.raceFirst(
      Effect.all([Stream.run(socketInput, helper.stdin), Stream.run(helper.stdout, socketOutput)], {
        concurrency: "unbounded",
        discard: true,
      }),
      helper.exitCode,
    ).pipe(Effect.ignore);
  });

  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    runConnection(
      handleConnection(socket).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.logWarning("Windows Computer Use bridge connection failed.", { cause }),
        ),
      ),
    );
  });
  const shutdown = yield* Effect.cached(shutdownNamedPipe(server, sockets, connectionScope));
  yield* Effect.acquireRelease(Effect.succeed(server), () => shutdown);
  const onServerError = (cause: Error) => {
    runBridgeTask(
      Effect.logWarning("Windows Computer Use bridge server failed.", { cause }).pipe(
        Effect.andThen(shutdown),
      ),
    );
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => server.on("error", onServerError)),
    () => Effect.sync(() => server.off("error", onServerError)),
  );
  yield* listenNamedPipe(server, pipePath);

  return {
    nodeModulesRoot: shim.nodeModulesRoot,
    trustedModuleSha256: COMPUTER_USE_SHIM_SHA256,
    pipePath,
  };
});
