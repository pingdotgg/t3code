import { createHash, randomUUID } from "node:crypto";

const ANSI_ESCAPE_REGEX = /\u001B\[[0-9;]*m/gu;
const TEXT_DECODER = new TextDecoder();

export const CODEX_BOOT_SENTINEL = "__JEVIN_CODEX_APP_SERVER_BOOT__";
export const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1_000;

export interface JsonRpcErrorShape {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

export interface JsonRpcRequestShape {
  readonly jsonrpc?: string;
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponseShape {
  readonly jsonrpc?: string;
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorShape;
}

export interface JsonRpcNotificationShape {
  readonly jsonrpc?: string;
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcEnvelope =
  | { readonly type: "request"; readonly value: JsonRpcRequestShape }
  | { readonly type: "response"; readonly value: JsonRpcResponseShape }
  | { readonly type: "notification"; readonly value: JsonRpcNotificationShape };

export interface DeviceAuthChallenge {
  readonly verificationUri: string;
  readonly userCode: string;
}

export interface PtyFrameState {
  readonly buffer: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createPtyFrameState(): PtyFrameState {
  return { buffer: "" };
}

export function createCodexHomePath(sandboxId: string, worktreePath: string): string {
  const digest = createHash("sha256")
    .update(`${sandboxId}:${worktreePath}`)
    .digest("hex")
    .slice(0, 16);
  return `/workspace/.jevin/codex/${digest}`;
}

export function createRequestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_REGEX, "");
}

export function createInitializeParams() {
  return {
    clientInfo: {
      name: "jevin_sandbox",
      title: "Jevin Sandbox",
      version: "0.0.1",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createJsonRpcRequest(id: string | number, method: string, params: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
}

export function createJsonRpcResult(id: string | number, result: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  });
}

export function createAppServerBootCommand(codexHomePath: string): string {
  return [
    `mkdir -p ${quoteShellArg(codexHomePath)}`,
    `cat > ${quoteShellArg(`${codexHomePath}/config.toml`)} <<'EOF'`,
    'cli_auth_credentials_store = "file"',
    "EOF",
    `printf '%s\\n' ${quoteShellArg(CODEX_BOOT_SENTINEL)}`,
    "exec codex app-server",
  ].join("\n");
}

export function createDeviceAuthBootCommand(codexHomePath: string): string {
  return [
    `mkdir -p ${quoteShellArg(codexHomePath)}`,
    `cat > ${quoteShellArg(`${codexHomePath}/config.toml`)} <<'EOF'`,
    'cli_auth_credentials_store = "file"',
    "EOF",
    "exec codex login --device-auth",
  ].join("\n");
}

export function tryExtractDeviceAuthChallenge(text: string): DeviceAuthChallenge | undefined {
  const sanitized = stripAnsi(text);
  const urlMatch = sanitized.match(/Open this link[\s\S]*?\n\s*(https?:\/\/\S+)/u);
  const codeMatch = sanitized.match(/Enter this one-time code[\s\S]*?\n\s*([A-Z0-9-]+)/iu);

  if (!urlMatch?.[1] || !codeMatch?.[1]) {
    return undefined;
  }

  return {
    verificationUri: urlMatch[1],
    userCode: codeMatch[1].toUpperCase(),
  };
}

export function tryParseJsonRpcLine(line: string): JsonRpcEnvelope | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const method = typeof parsed.method === "string" ? parsed.method : undefined;
  const id = typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : undefined;

  if (method && id !== undefined) {
    return {
      type: "request",
      value: {
        jsonrpc: typeof parsed.jsonrpc === "string" ? parsed.jsonrpc : undefined,
        id,
        method,
        params: parsed.params,
      },
    };
  }

  if (method) {
    return {
      type: "notification",
      value: {
        jsonrpc: typeof parsed.jsonrpc === "string" ? parsed.jsonrpc : undefined,
        method,
        params: parsed.params,
      },
    };
  }

  if (id !== undefined) {
    let error: JsonRpcErrorShape | undefined;
    if (isRecord(parsed.error)) {
      error = {
        code: typeof parsed.error.code === "number" ? parsed.error.code : undefined,
        message: typeof parsed.error.message === "string" ? parsed.error.message : undefined,
        data: parsed.error.data,
      };
    }

    return {
      type: "response",
      value: {
        jsonrpc: typeof parsed.jsonrpc === "string" ? parsed.jsonrpc : undefined,
        id,
        result: parsed.result,
        error,
      },
    };
  }

  return undefined;
}

export function consumePtyLines(
  state: PtyFrameState,
  chunk: Uint8Array,
): { readonly state: PtyFrameState; readonly lines: readonly string[] } {
  const combined = state.buffer + TEXT_DECODER.decode(chunk);
  const parts = combined.split(/\r?\n/u);
  const remainder = parts.pop() ?? "";

  return {
    state: { buffer: remainder },
    lines: parts,
  };
}
