#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

interface ReplayEntry {
  readonly type: "emit_inbound" | "expect_outbound" | "runtime_exit";
  readonly label?: string;
  readonly frame?: unknown;
  readonly status?: "success" | "error" | "cancelled";
  readonly error?: unknown;
}

interface ReplayTranscript {
  readonly scenario: string;
  readonly entries: ReadonlyArray<ReplayEntry>;
}

interface LogicalFrame {
  readonly kind: "notification" | "request" | "response";
  readonly method: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly headers?: ReadonlyArray<unknown>;
}

const encodedTranscript = process.env.T3_ACP_REPLAY_TRANSCRIPT;
const statusPath = process.env.T3_ACP_REPLAY_STATUS_PATH;
const replayWorkspace = process.env.T3_ACP_REPLAY_WORKSPACE ?? process.cwd();

if (encodedTranscript === undefined || statusPath === undefined) {
  process.stderr.write("ACP replay requires transcript and status environment variables.\n");
  process.exit(2);
}

const replayStatusPath = statusPath;
const transcript = JSON.parse(
  Buffer.from(encodedTranscript, "base64").toString("utf8"),
) as ReplayTranscript;
let cursor = 0;
let stopped = false;
let nextAgentRequestId = 1;
const pendingClientRequestIds = new Map<string, string | number>();
const pendingAgentRequestMethods = new Map<string, string>();

function writeStatus(failure?: unknown): void {
  NodeFS.writeFileSync(
    replayStatusPath,
    JSON.stringify({
      scenario: transcript.scenario,
      cursor,
      total: transcript.entries.length,
      ...(failure === undefined ? {} : { failure }),
    }),
    "utf8",
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expandExpectedString(value: string): string {
  return value.replaceAll("<workspace>", replayWorkspace);
}

function matchesExpected(expected: unknown, actual: unknown): boolean {
  if (expected === "<any>") return true;
  if (typeof expected === "string" && typeof actual === "string") {
    const expanded = expandExpectedString(expected);
    if (!expanded.includes("<any>")) return expanded === actual;
    const parts = expanded.split("<any>");
    let offset = 0;
    for (const part of parts) {
      const index = actual.indexOf(part, offset);
      if (index === -1) return false;
      offset = index + part.length;
    }
    return true;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => matchesExpected(entry, actual[index]))
    );
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord).toSorted();
    const actualKeys = Object.keys(actualRecord).toSorted();
    return (
      stableStringify(expectedKeys) === stableStringify(actualKeys) &&
      expectedKeys.every((key) => matchesExpected(expectedRecord[key], actualRecord[key]))
    );
  }
  return Object.is(expected, actual);
}

function stopWithFailure(detail: string, actual?: unknown): void {
  if (stopped) return;
  stopped = true;
  const entry = transcript.entries[cursor];
  const failure = {
    detail,
    cursor,
    expected: entry,
    ...(actual === undefined ? {} : { actual }),
  };
  writeStatus(failure);
  process.stderr.write(`ACP replay mismatch: ${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
  process.stdin.pause();
}

function advance(): void {
  cursor += 1;
  writeStatus();
}

function send(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function pendingClientRequestId(method: string): string | number | undefined {
  return pendingClientRequestIds.get(method);
}

function logicalIncoming(message: JsonRpcMessage): LogicalFrame | undefined {
  if (typeof message.method === "string") {
    return {
      kind:
        message.id === undefined || message.id === null || message.id === ""
          ? "notification"
          : "request",
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    };
  }
  if (message.id === undefined || message.id === null) return undefined;
  const method = pendingAgentRequestMethods.get(String(message.id));
  if (method === undefined) return undefined;
  return {
    kind: "response",
    method,
    ...(message.result === undefined ? {} : { result: message.result }),
    ...(message.error === undefined ? {} : { error: message.error }),
  };
}

function emitInbound(frame: LogicalFrame): void {
  switch (frame.kind) {
    case "notification":
      send({
        jsonrpc: "2.0",
        method: frame.method,
        ...(frame.params === undefined ? {} : { params: frame.params }),
      });
      return;
    case "request": {
      const id = nextAgentRequestId;
      nextAgentRequestId += 1;
      pendingAgentRequestMethods.set(String(id), frame.method);
      send({
        jsonrpc: "2.0",
        id,
        method: frame.method,
        ...(frame.params === undefined ? {} : { params: frame.params }),
        headers: [],
      });
      return;
    }
    case "response": {
      const id = pendingClientRequestId(frame.method);
      if (id === undefined) {
        stopWithFailure(`No pending client request for ${frame.method}`, frame);
        return;
      }
      pendingClientRequestIds.delete(frame.method);
      send({
        jsonrpc: "2.0",
        id,
        ...(frame.result === undefined ? {} : { result: frame.result }),
        ...(frame.error === undefined ? {} : { error: frame.error }),
      });
    }
  }
}

function flushInbound(): void {
  while (!stopped) {
    const entry = transcript.entries[cursor];
    if (entry === undefined || entry.type === "expect_outbound") return;
    if (entry.type === "runtime_exit") {
      if (entry.status !== "success") {
        stopWithFailure(`Recorded runtime exit was ${entry.status ?? "unknown"}`, entry.error);
        return;
      }
      advance();
      continue;
    }
    const frame = entry.frame as LogicalFrame;
    if (
      typeof frame !== "object" ||
      frame === null ||
      !["notification", "request", "response"].includes(frame.kind) ||
      typeof frame.method !== "string"
    ) {
      stopWithFailure("Invalid emit_inbound logical ACP frame", entry.frame);
      return;
    }
    emitInbound(frame);
    if (stopped) return;
    advance();
  }
}

function handleMessage(message: JsonRpcMessage): void {
  if (stopped) return;
  const actual = logicalIncoming(message);
  if (actual === undefined) {
    stopWithFailure("Could not identify outbound ACP frame", message);
    return;
  }
  const entry = transcript.entries[cursor];
  if (entry?.type !== "expect_outbound" || !matchesExpected(entry.frame, actual)) {
    if (actual.kind === "request" && message.id !== undefined && message.id !== null) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "ACP replay frame mismatch" },
      });
    }
    stopWithFailure("Unexpected outbound ACP frame", actual);
    return;
  }
  if (actual.kind === "request" && message.id !== undefined && message.id !== null) {
    pendingClientRequestIds.set(actual.method, message.id);
  } else if (actual.kind === "response" && message.id !== undefined && message.id !== null) {
    pendingAgentRequestMethods.delete(String(message.id));
  }
  advance();
  flushInbound();
}

writeStatus();
flushInbound();

const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (stopped || line.trim().length === 0) return;
  try {
    handleMessage(JSON.parse(line) as JsonRpcMessage);
  } catch (cause) {
    stopWithFailure("Failed to decode outbound ACP JSON-RPC", String(cause));
  }
});

input.on("close", () => {
  if (!stopped && cursor !== transcript.entries.length) {
    stopWithFailure("ACP replay input closed before transcript completion");
  }
});
