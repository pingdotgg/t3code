// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const COMPUTER_USE_HELPER_RELATIVE_PATH = NodePath.join(
  "@oai",
  "sky",
  "bin",
  "windows",
  "codex-computer-use.exe",
);
const COMPUTER_USE_SHIM_PACKAGE_JSON = `${JSON.stringify({
  name: "@oai/sky",
  private: true,
  type: "module",
  exports: "./index.js",
})}\n`;

// This module is trusted by its exact SHA-256, not by directory. Keep it
// self-contained: importing another module would expand the trusted graph.
// The model receives only the frozen Sky facade; the native pipe, helper
// metadata and session approval cache stay in this module's closure.
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
    // Key on the stable window id, not the full window object: titles churn
    // (dirty markers, tab switches) and would silently expire session grants.
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
    connectionPromise = nodeRepl.nativePipe.createConnection(pipePath).then((connection) => {
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
        const message = sanitizeError(reason || "Computer Use pipe closed");
        connectionPromise = undefined;
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timeout);
          waiter.reject(new Error(message));
        }
        pending.clear();
      };
      connection.on("error", rejectAll);
      connection.on("close", () => rejectAll("Computer Use pipe closed"));
      return connection;
    });
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
      if (decision?._meta?.persist === "session") sessionApprovedScopes.add(approvalScope);
    }

    const approvedMetadata = inertClone(metadata, "Computer Use metadata");
    approvedMetadata["x-oai-cua-approved-app"] = app;
    response = await send(method, params, approvedMetadata);
  }

  if (response?.ok !== true) {
    throw new Error(
      typeof response?.error === "string" ? response.error.slice(0, 2000) : "Computer Use request failed",
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

// SECURITY NOTE: the pipe server forwards requests to the helper without its
// own authentication; approval is enforced by the shim via the
// x-oai-cua-approved-app metadata it attaches after an elicitation. This is
// sound only because (a) untrusted node_repl code cannot open raw named pipes
// (nativePipe is a trusted-module-only capability) and (b) the pipe name,
// while present in the node_repl process env, is unreachable without that
// capability. If the sandbox ever exposes raw pipe/socket access to model
// code, this bridge needs server-side authentication of its clients.
export interface CodexComputerUseBridgeConfig {
  readonly nodeModulesRoot: string;
  readonly trustedModuleSha256: string;
  readonly pipePath: string;
}

export interface CodexComputerUseBridge {
  readonly config: CodexComputerUseBridgeConfig;
  readonly close: Effect.Effect<void>;
}

export interface CodexComputerUseBridgeInput {
  readonly codexHome: string;
  readonly nodeModuleRoots: ReadonlyArray<string>;
}

export class CodexComputerUseBridgeError extends Schema.TaggedErrorClass<CodexComputerUseBridgeError>()(
  "CodexComputerUseBridgeError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to start the T3 Computer Use bridge";
  }
}

export function findComputerUseHelper(
  nodeModuleRoots: ReadonlyArray<string>,
): Effect.Effect<string | undefined> {
  return Effect.promise(async () => {
    for (const root of nodeModuleRoots) {
      const candidate = NodePath.join(root, COMPUTER_USE_HELPER_RELATIVE_PATH);
      try {
        const stat = await NodeFSP.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // A configured module search root may be absent on this host.
      }
    }
    return undefined;
  });
}

async function writeFileExactly(path: string, content: string): Promise<void> {
  try {
    const existing = await NodeFSP.readFile(path, "utf8");
    if (existing !== content) {
      throw new Error(`Refusing to use mismatched Computer Use shim: ${path}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporaryPath = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  try {
    await NodeFSP.rename(temporaryPath, path);
  } catch (error) {
    await NodeFSP.rm(temporaryPath, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await NodeFSP.readFile(path, "utf8");
    if (existing !== content) {
      throw new Error(`Refusing to use mismatched Computer Use shim: ${path}`, { cause: error });
    }
  }
}

export function materializeComputerUseShim(
  codexHome: string,
): Effect.Effect<{ readonly nodeModulesRoot: string; readonly entryPath: string }> {
  return Effect.promise(async () => {
    const nodeModulesRoot = NodePath.join(
      codexHome,
      "cache",
      "t3-code",
      "cua-shim",
      COMPUTER_USE_SHIM_SHA256,
      "node_modules",
    );
    const packageDirectory = NodePath.join(nodeModulesRoot, "@oai", "sky");
    await NodeFSP.mkdir(packageDirectory, { recursive: true });
    const entryPath = NodePath.join(packageDirectory, "index.js");
    await writeFileExactly(entryPath, COMPUTER_USE_SHIM_SOURCE);
    await writeFileExactly(
      NodePath.join(packageDirectory, "package.json"),
      COMPUTER_USE_SHIM_PACKAGE_JSON,
    );
    return { nodeModulesRoot, entryPath };
  });
}

export function makeCodexComputerUseBridge(
  input: CodexComputerUseBridgeInput,
): Effect.Effect<
  CodexComputerUseBridge | undefined,
  CodexComputerUseBridgeError,
  import("effect/Scope").Scope
> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const helperPath = await Effect.runPromise(findComputerUseHelper(input.nodeModuleRoots));
        if (!helperPath) return undefined;

        const shim = await Effect.runPromise(materializeComputerUseShim(input.codexHome));
        const pipePath = `\\\\.\\pipe\\t3code-cua-${NodeCrypto.randomUUID()}`;
        const helpers = new Set<NodeChildProcess.ChildProcess>();
        const sockets = new Set<NodeNet.Socket>();
        const server = NodeNet.createServer((socket) => {
          sockets.add(socket);
          const helper = NodeChildProcess.spawn(helperPath, ["--parent-pid", String(process.pid)], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          helpers.add(helper);
          socket.pipe(helper.stdin!);
          helper.stdout!.pipe(socket);
          helper.stderr?.on("data", () => undefined);
          const close = () => {
            sockets.delete(socket);
            helpers.delete(helper);
            if (!socket.destroyed) socket.destroy();
            if (helper.exitCode === null && helper.signalCode === null) helper.kill();
          };
          socket.once("error", close);
          socket.once("close", close);
          helper.once("error", close);
          helper.once("exit", close);
        });

        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(pipePath);
        });

        return {
          config: {
            nodeModulesRoot: shim.nodeModulesRoot,
            trustedModuleSha256: COMPUTER_USE_SHIM_SHA256,
            pipePath,
          },
          closePromise: async () => {
            for (const socket of sockets) socket.destroy();
            for (const helper of helpers) {
              if (helper.exitCode === null && helper.signalCode === null) helper.kill();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
          },
        };
      },
      catch: (cause) => new CodexComputerUseBridgeError({ cause }),
    }),
    (bridge) =>
      bridge
        ? Effect.tryPromise({
            try: () => bridge.closePromise(),
            catch: () => undefined,
          }).pipe(Effect.ignore)
        : Effect.void,
  ).pipe(
    Effect.map((bridge) =>
      bridge
        ? {
            config: bridge.config,
            close: Effect.tryPromise({
              try: () => bridge.closePromise(),
              catch: () => undefined,
            }).pipe(Effect.ignore),
          }
        : undefined,
    ),
  );
}
