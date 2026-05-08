// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import * as NodeTimers from "node:timers";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcId = number | string;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: JsonValue;
  headers?: JsonValue;
};

type SelectLeafOption = {
  value: string;
  label?: string;
  name?: string;
};

type SelectGroupOption = {
  label?: string;
  name?: string;
  options: SelectLeafOption[];
};

type SessionConfigOption = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  options?: Array<SelectLeafOption | SelectGroupOption>;
};

type SessionNewResult = {
  sessionId: string;
  configOptions?: SessionConfigOption[];
};

type SetConfigResult = {
  configOptions?: SessionConfigOption[];
};

type PendingRequest = {
  method: string;
  resolve: (value: JsonValue | undefined) => void;
  reject: (error: Error) => void;
};

const targetCwd = process.argv[2] ?? process.cwd();
const targetModel = process.argv[3] ?? "gpt-5.4";
const promptText = process.argv[4] ?? "helo";
const targetReasoning = process.env.CURSOR_REASONING ?? "";
const targetContext = process.env.CURSOR_CONTEXT ?? "";
const targetFast = process.env.CURSOR_FAST ?? "";
const agentBin = process.env.CURSOR_AGENT_BIN ?? "agent";
const promptWaitMs = Number(process.env.CURSOR_PROMPT_WAIT_MS ?? "4000");
const requestTimeoutMs = Number(process.env.CURSOR_REQUEST_TIMEOUT_MS ?? "20000");

function logSection(title: string, value: unknown) {
  process.stdout.write(`\n=== ${title} ===\n`);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  throw new Error(message);
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function flattenSelectValues(option: SessionConfigOption | undefined): string[] {
  if (!option || option.type !== "select" || !Array.isArray(option.options)) {
    return [];
  }

  const values: string[] = [];
  for (const entry of option.options) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if ("value" in entry && typeof entry.value === "string") {
      values.push(entry.value);
      continue;
    }
    if ("options" in entry && Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        if (nested && typeof nested === "object" && typeof nested.value === "string") {
          values.push(nested.value);
        }
      }
    }
  }
  return values;
}

function findConfigOption(
  configOptions: SessionConfigOption[],
  predicate: (option: SessionConfigOption) => boolean,
): SessionConfigOption | undefined {
  return configOptions.find(predicate);
}

function matchesKeyword(option: SessionConfigOption, keyword: string): boolean {
  const haystack = `${option.id} ${option.name ?? ""}`.toLowerCase();
  return haystack.includes(keyword.toLowerCase());
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    // @effect-diagnostics-next-line globalTimers:off - Standalone Node probe script, not an Effect runtime test.
    NodeTimers.setTimeout(resolve, ms);
  });
}

class JsonRpcChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending = new Map<JsonRpcId, PendingRequest>();
  nextId = 1;
  closed = false;

  constructor(bin: string, args: string[], cwd: string) {
    this.child = spawn(bin, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const detail = `ACP process exited (code=${String(code)}, signal=${String(signal)})`;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`${detail} while waiting for ${pending.method}`));
      }
      this.pending.clear();
    });

    this.child.on("error", (error) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    const stdout = readline.createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => {
      void this.handleStdoutLine(line);
    });

    const stderr = readline.createInterface({ input: this.child.stderr });
    stderr.on("line", (line) => {
      process.stdout.write(`[stderr] ${line}\n`);
    });
  }

  write(message: JsonRpcMessage) {
    if (this.closed) {
      fail("ACP process is already closed.");
    }
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      headers: [],
      ...message,
    });
    process.stdout.write(`>>> ${payload}\n`);
    this.child.stdin.write(`${payload}\n`);
  }

  async request(method: string, params: JsonValue, timeoutMs = requestTimeoutMs) {
    const id = this.nextId++;

    const responsePromise = new Promise<JsonValue | undefined>((resolve, reject) => {
      // @effect-diagnostics-next-line globalTimers:off - Standalone Node probe script request timeout.
      const timeout = NodeTimers.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => {
          NodeTimers.clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          NodeTimers.clearTimeout(timeout);
          reject(error);
        },
      });
    });

    this.write({
      id,
      method,
      params,
    });

    return responsePromise;
  }

  notify(method: string, params: JsonValue) {
    this.write({
      method,
      params,
    });
  }

  respond(id: JsonRpcId, result: JsonValue) {
    this.write({
      id,
      result,
    });
  }

  respondError(id: JsonRpcId, code: number, message: string) {
    this.write({
      id,
      error: {
        code,
        message,
      },
    });
  }

  async handleStdoutLine(line: string) {
    if (line.trim().length === 0) {
      return;
    }

    process.stdout.write(`<<< ${line}\n`);

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      process.stdout.write(`[parse-error] ${(error as Error).message}\n`);
      return;
    }

    if (typeof message.id !== "undefined" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (typeof message.error !== "undefined") {
        pending.reject(
          new Error(`RPC ${pending.method} failed: ${JSON.stringify(message.error, null, 2)}`),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method === "session/request_permission" && typeof message.id !== "undefined") {
      this.respond(message.id, {
        outcome: {
          outcome: "selected",
          optionId: "allow",
        },
      });
      return;
    }

    if (typeof message.id !== "undefined" && message.id !== "") {
      this.respondError(
        message.id,
        -32601,
        `Unhandled server request: ${message.method ?? "unknown"}`,
      );
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.child.kill("SIGTERM");
    await sleep(250);
    if (!this.closed) {
      this.child.kill("SIGKILL");
    }
  }
}

async function setSelectOptionIfAdvertised(
  rpc: JsonRpcChild,
  sessionId: string,
  configOptions: SessionConfigOption[],
  predicate: (option: SessionConfigOption) => boolean,
  value: string,
  label: string,
) {
  if (value.length === 0) {
    return configOptions;
  }

  const option = findConfigOption(configOptions, predicate);
  const values = flattenSelectValues(option);
  if (!option || !values.includes(value)) {
    logSection(`SKIP_${label}`, {
      requestedValue: value,
      availableValues: values,
    });
    return configOptions;
  }

  const response = (await rpc.request("session/set_config_option", {
    sessionId,
    configId: option.id,
    value,
  })) as SetConfigResult | null | undefined;

  logSection(`SET_${label}_RESPONSE`, response);
  return response?.configOptions ?? configOptions;
}

async function main() {
  const rpc = new JsonRpcChild(agentBin, ["acp"], targetCwd);

  try {
    const initializeResponse = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: {
          parameterizedModelPicker: true,
        },
      },
      clientInfo: {
        name: "cursor-acp-model-mismatch-probe",
        version: "0.0.0",
      },
    });
    logSection("INITIALIZE_RESPONSE", initializeResponse);

    const authenticateResponse = await rpc.request("authenticate", {
      methodId: "cursor_login",
    });
    logSection("AUTHENTICATE_RESPONSE", authenticateResponse);

    const sessionResponse = (await rpc.request("session/new", {
      cwd: targetCwd,
      mcpServers: [],
    })) as SessionNewResult;
    logSection("SESSION_NEW_RESPONSE", sessionResponse);

    const sessionId = asString(sessionResponse.sessionId);
    if (!sessionId) {
      fail("session/new did not return a sessionId.");
    }

    let configOptions = sessionResponse.configOptions ?? [];
    const modelConfig = findConfigOption(configOptions, (option) => option.category === "model");
    const advertisedModels = flattenSelectValues(modelConfig);
    logSection("ADVERTISED_MODEL_VALUES", advertisedModels);

    if (!modelConfig || modelConfig.type !== "select") {
      fail("Cursor ACP did not expose a select-type model config option.");
    }

    if (!advertisedModels.includes(targetModel)) {
      fail(
        `Cursor ACP did not advertise model ${JSON.stringify(targetModel)}. Advertised values: ${advertisedModels.join(", ")}`,
      );
    }

    const setModelResponse = (await rpc.request("session/set_config_option", {
      sessionId,
      configId: modelConfig.id,
      value: targetModel,
    })) as SetConfigResult | null | undefined;
    logSection("SET_MODEL_RESPONSE", setModelResponse);

    configOptions = setModelResponse?.configOptions ?? configOptions;

    configOptions = await setSelectOptionIfAdvertised(
      rpc,
      sessionId,
      configOptions,
      (option) => option.category === "thought_level",
      targetReasoning,
      "REASONING",
    );

    configOptions = await setSelectOptionIfAdvertised(
      rpc,
      sessionId,
      configOptions,
      (option) => option.category === "model_config" && matchesKeyword(option, "context"),
      targetContext,
      "CONTEXT",
    );

    configOptions = await setSelectOptionIfAdvertised(
      rpc,
      sessionId,
      configOptions,
      (option) => option.category === "model_config" && matchesKeyword(option, "fast"),
      targetFast,
      "FAST",
    );

    const promptResponse = await rpc.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: promptText,
        },
      ],
    });
    logSection("PROMPT_RESPONSE", promptResponse);

    await sleep(promptWaitMs);
    rpc.notify("session/cancel", { sessionId });
  } finally {
    await rpc.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
