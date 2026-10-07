// @effect-diagnostics globalTimers:off - The bridge runs in the client, outside an Effect runtime.
import { MCP_APP_PROTOCOL_VERSION, type McpAppReference } from "@t3tools/shared/mcpApp";
import * as Base64 from "effect/encoding/Base64";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

/**
 * The host side of the MCP Apps bridge (spec 2026-01-26, plus the draft
 * additions the current SDK sends: `ui/download-file` and
 * `ui/notifications/request-teardown`): JSON-RPC 2.0 over postMessage between a
 * client and one app document. It is transport-free so web (an iframe) and
 * mobile (a WebView) share every protocol rule; each platform supplies how to
 * post a message and how to reach the environment.
 */

const MAX_MESSAGE_BYTES = 256 * 1024;
/** Requests an app may have in flight at once; more are refused, not queued. */
const MAX_PENDING_REQUESTS = 16;
/** How long the host waits for an app to answer `ui/resource-teardown`. */
const TEARDOWN_TIMEOUT_MS = 2000;
const encoder = new TextEncoder();

type JsonRpcId = string | number;

export type McpAppDisplayMode = "inline" | "fullscreen" | "pip";

export interface McpAppHostContext {
  readonly theme: "light" | "dark";
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly displayMode: McpAppDisplayMode;
  readonly availableDisplayModes: ReadonlyArray<McpAppDisplayMode>;
  /**
   * `maxHeight` when the host sizes the frame to the app's reported height,
   * `height` when the frame is a fixed box the app must fit (spec
   * "Container Dimensions").
   */
  readonly containerDimensions:
    | { readonly width: number; readonly maxHeight: number }
    | { readonly width: number; readonly height: number };
  readonly platform: "web" | "desktop" | "mobile";
  readonly locale?: string;
  readonly timeZone?: string;
  readonly userAgent?: string;
  readonly deviceCapabilities?: { readonly touch?: boolean; readonly hover?: boolean };
  readonly safeAreaInsets?: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  /** The tool call that created the app: the server's MCP `Tool` definition. */
  readonly toolInfo?: { readonly tool: unknown };
}

/** A file an app asked the host to save (`ui/download-file`): embedded, or linked on its server. */
export type McpAppDownload =
  | {
      readonly _tag: "embedded";
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly _tag: "link";
      readonly name: string;
      readonly uri: string;
      readonly mimeType?: string;
    };

/**
 * The bytes of an MCP resource's contents: `text` as UTF-8, `blob` decoded
 * from base64. Undefined when it has neither or the base64 is malformed.
 */
export function mcpResourceBytes(content: unknown): Uint8Array | undefined {
  if (!Predicate.isObject(content)) return undefined;
  if (typeof content.text === "string") return encoder.encode(content.text);
  if (typeof content.blob === "string") {
    const decoded = Base64.decode(content.blob);
    return Result.isSuccess(decoded) ? decoded.success : undefined;
  }
  return undefined;
}

export interface McpAppCallToolResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
  readonly _meta?: unknown;
}

/** Thrown by host callbacks to refuse a request with a message the app can show. */
export class McpAppHostRefusal extends Error {}

export interface McpAppHostOptions {
  readonly app: McpAppReference;
  readonly hostVersion: string;
  /** Posts one JSON-RPC message to the app document. */
  readonly post: (message: unknown) => void;
  readonly hostContext: () => McpAppHostContext;

  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<McpAppCallToolResult>;
  readonly readResource: (input: { readonly uri: string }) => Promise<unknown>;
  readonly openLink: (url: string) => Promise<void>;
  readonly sendMessage: (text: string) => Promise<void>;
  /** Replaces what this app tells the agent on its next turn; undefined content clears it. */
  readonly updateModelContext: (context: {
    readonly content?: ReadonlyArray<unknown>;
    readonly structuredContent?: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * Switches the app to a mode the host and the app both offer, returning the
   * resulting mode. The host has already checked both lists.
   */
  readonly requestDisplayMode: (mode: McpAppDisplayMode) => Promise<McpAppDisplayMode>;
  readonly downloadFile: (files: ReadonlyArray<McpAppDownload>) => Promise<void>;
  /** The app asked to be closed (`ui/notifications/request-teardown`). */
  readonly onRequestTeardown: () => void;
  readonly onSizeChanged: (size: { readonly width?: number; readonly height?: number }) => void;
}

export interface McpAppHost {
  /** Handles one message the app posted; the caller has already checked its source. */
  readonly receive: (data: unknown) => void;
  /**
   * Supplies the original tool call's arguments and result. They reach the
   * app once it has initialized, whichever happens last, and only once.
   */
  readonly setToolCall: (call: {
    readonly arguments: unknown;
    readonly result: McpAppCallToolResult | undefined;
  }) => void;
  /** Sends `host-context-changed` with the fields that differ from what the app last saw. */
  readonly updateHostContext: () => void;
  /**
   * Asks the app to wrap up before its document goes away (`ui/resource-teardown`),
   * resolving once it answers or after a short timeout, then disposes the host.
   */
  readonly teardown: () => Promise<void>;
  readonly dispose: () => void;
}

function jsonBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * A `CallToolResult` as the spec's schema accepts it. Providers can report
 * absent fields as null (Codex sends `_meta: null`), which the MCP Apps SDK
 * rejects, dropping the whole notification or response.
 */
function normalizeMcpAppToolResult(result: McpAppCallToolResult): McpAppCallToolResult {
  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(Predicate.isObject(result.structuredContent)
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(Predicate.isObject(result._meta) ? { _meta: result._meta } : {}),
  };
}

const errorMessage = (error: unknown) =>
  error instanceof McpAppHostRefusal
    ? error.message
    : error instanceof Error && error.message.trim() !== ""
      ? error.message
      : "Request failed.";

export function makeMcpAppHost(options: McpAppHostOptions): McpAppHost {
  let initialized = false;
  let disposed = false;
  let toolCall:
    | { readonly arguments: unknown; readonly result: McpAppCallToolResult | undefined }
    | undefined;
  let toolCallSent = false;
  let pending = 0;
  let sentContext: McpAppHostContext | undefined;
  /** Modes the app declared at initialize; undefined when it declared none. */
  let appDisplayModes: ReadonlyArray<string> | undefined;
  let nextHostRequestId = 0;
  const hostRequests = new Map<string, () => void>();

  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: JsonRpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string) =>
    post({ jsonrpc: "2.0", id, error: { code, message } });

  const sendToolCall = () => {
    if (!initialized || toolCall === undefined || toolCallSent) return;
    toolCallSent = true;
    notify("ui/notifications/tool-input", {
      arguments: Predicate.isObject(toolCall.arguments) ? toolCall.arguments : {},
    });
    if (toolCall.result !== undefined) {
      notify("ui/notifications/tool-result", normalizeMcpAppToolResult(toolCall.result));
    }
  };

  const answer = (id: JsonRpcId, run: () => Promise<unknown>) => {
    if (pending >= MAX_PENDING_REQUESTS) {
      fail(id, -32000, "Too many requests in flight.");
      return;
    }
    pending += 1;
    void run().then(
      (result) => {
        pending -= 1;
        respond(id, result);
      },
      (error: unknown) => {
        pending -= 1;
        fail(id, -32000, errorMessage(error));
      },
    );
  };

  const handleRequest = (id: JsonRpcId, method: string, params: Record<PropertyKey, unknown>) => {
    switch (method) {
      case "ui/initialize": {
        const requested = params.protocolVersion;
        const declared = Predicate.isObject(params.appCapabilities)
          ? params.appCapabilities.availableDisplayModes
          : undefined;
        appDisplayModes = Array.isArray(declared)
          ? declared.filter((mode): mode is string => typeof mode === "string")
          : undefined;
        sentContext = options.hostContext();
        respond(id, {
          protocolVersion:
            requested === MCP_APP_PROTOCOL_VERSION ? requested : MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "t3-code", version: options.hostVersion },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            logging: {},
            message: { text: {} },
            updateModelContext: { text: {}, structuredContent: {} },
            downloadFile: {},
            sandbox: {
              ...(options.app.csp === undefined ? {} : { csp: options.app.csp }),
              ...(options.app.permissions === undefined
                ? {}
                : { permissions: options.app.permissions }),
            },
          },
          hostContext: sentContext,
        });
        return;
      }
      case "ping":
        respond(id, {});
        return;
      case "tools/call": {
        const name = params.name;
        const args = params.arguments ?? {};
        if (typeof name !== "string" || name.trim() === "" || !Predicate.isObject(args)) {
          fail(id, -32602, "tools/call needs a tool name and object arguments.");
          return;
        }
        answer(id, () =>
          options
            .callTool({ name, arguments: args as Record<string, unknown> })
            .then(normalizeMcpAppToolResult),
        );
        return;
      }
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string" || uri.trim() === "") {
          fail(id, -32602, "resources/read needs a uri.");
          return;
        }
        answer(id, () => options.readResource({ uri }));
        return;
      }
      case "ui/open-link": {
        const url = params.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          fail(id, -32602, "Only http(s) links can be opened.");
          return;
        }
        answer(id, () => options.openLink(url).then(() => ({})));
        return;
      }
      case "ui/message": {
        // The SDK sends an array of content blocks; the spec text shows one block.
        const blocks = Array.isArray(params.content) ? params.content : [params.content];
        const texts = blocks.map((block) =>
          Predicate.isObject(block) && block.type === "text" && typeof block.text === "string"
            ? block.text
            : undefined,
        );
        if (params.role !== "user" || texts.length === 0 || texts.includes(undefined)) {
          fail(id, -32602, "Only text messages from the user role are supported.");
          return;
        }
        const text = texts.join("\n").trim();
        if (text === "") {
          fail(id, -32602, "ui/message needs non-empty text.");
          return;
        }
        answer(id, () => options.sendMessage(text).then(() => ({})));
        return;
      }
      case "ui/request-display-mode": {
        const current = options.hostContext().displayMode;
        const mode = params.mode;
        // A mode the host lacks, or the app did not declare, leaves the
        // current one; the spec has the host answer with whichever applies.
        const allowed =
          typeof mode === "string" &&
          options.hostContext().availableDisplayModes.includes(mode as McpAppDisplayMode) &&
          (appDisplayModes === undefined || appDisplayModes.includes(mode));
        if (!allowed || mode === current) {
          respond(id, { mode: current });
          return;
        }
        answer(id, () =>
          options
            .requestDisplayMode(mode as McpAppDisplayMode)
            .then((result) => ({ mode: result })),
        );
        return;
      }
      case "ui/update-model-context": {
        const content = params.content;
        const structured = params.structuredContent;
        if (
          (content !== undefined && !Array.isArray(content)) ||
          (structured !== undefined && !Predicate.isObject(structured))
        ) {
          fail(
            id,
            -32602,
            "Model context needs content blocks or an object of structured content.",
          );
          return;
        }
        answer(id, () =>
          options
            .updateModelContext({
              ...(content === undefined ? {} : { content }),
              ...(structured === undefined
                ? {}
                : { structuredContent: structured as Record<string, unknown> }),
            })
            .then(() => ({})),
        );
        return;
      }
      case "ui/download-file": {
        const files = readDownloads(params.contents);
        if (files === undefined) {
          fail(id, -32602, "ui/download-file needs embedded resources or resource links.");
          return;
        }
        answer(id, () =>
          options.downloadFile(files).then(
            () => ({}),
            // The draft reports a refused or failed download in the result.
            (error: unknown) =>
              error instanceof McpAppHostRefusal ? { isError: true } : Promise.reject(error),
          ),
        );
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  };

  const handleNotification = (method: string, params: Record<PropertyKey, unknown>) => {
    switch (method) {
      case "ui/notifications/initialized": {
        if (initialized) return;
        initialized = true;
        sendToolCall();
        // The theme or size may have changed since the initialize response.
        hostHandle.updateHostContext();
        return;
      }
      case "ui/notifications/size-changed": {
        const width = typeof params.width === "number" ? params.width : undefined;
        const height = typeof params.height === "number" ? params.height : undefined;
        if (width !== undefined || height !== undefined) {
          options.onSizeChanged({
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
          });
        }
        return;
      }
      case "ui/notifications/request-teardown":
        options.onRequestTeardown();
        return;
      default:
      // notifications/message (logging) and unknown notifications are ignored.
    }
  };

  /** A response to a request the host sent the app. */
  const handleResponse = (id: JsonRpcId) => {
    const settle = hostRequests.get(String(id));
    if (settle === undefined) return;
    hostRequests.delete(String(id));
    settle();
  };

  const hostHandle: McpAppHost = {
    receive: (data) => {
      if (disposed || !Predicate.isObject(data) || data.jsonrpc !== "2.0") return;
      if (jsonBytes(data) > MAX_MESSAGE_BYTES) {
        if (isId(data.id) && typeof data.method === "string") {
          fail(data.id, -32600, "Message too large.");
        }
        return;
      }
      const method = data.method;
      if (typeof method !== "string") {
        if (isId(data.id) && ("result" in data || "error" in data)) handleResponse(data.id);
        return;
      }
      const params = Predicate.isObject(data.params) ? data.params : {};
      if (isId(data.id)) handleRequest(data.id, method, params);
      else handleNotification(method, params);
    },
    setToolCall: (call) => {
      toolCall ??= call;
      sendToolCall();
    },
    updateHostContext: () => {
      // The spec forbids messages before the app finishes initializing; it
      // reads the then-current context from the initialize response anyway.
      if (!initialized || sentContext === undefined) return;
      const next = options.hostContext();
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(next) as Array<keyof McpAppHostContext>) {
        if (JSON.stringify(next[key]) !== JSON.stringify(sentContext[key])) {
          changes[key] = next[key];
        }
      }
      sentContext = next;
      if (Object.keys(changes).length > 0) {
        notify("ui/notifications/host-context-changed", changes);
      }
    },
    teardown: () =>
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          clearTimeout(timer);
          disposed = true;
          resolve();
        };
        // Before initialization the app has nothing to save and may not be
        // listening; the spec only asks for teardown after it.
        if (disposed || !initialized) {
          finish();
          return;
        }
        const id = `t3-host-${nextHostRequestId++}`;
        hostRequests.set(id, finish);
        timer = setTimeout(() => {
          hostRequests.delete(id);
          finish();
        }, TEARDOWN_TIMEOUT_MS);
        post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
      }),
    dispose: () => {
      disposed = true;
    },
  };
  return hostHandle;
}

const MAX_DOWNLOAD_NAME = 200;

/** The file name an app gave a download, or the last part of its URI. */
function downloadName(uri: unknown, name: unknown): string {
  const raw =
    typeof name === "string" && name.trim() !== ""
      ? name
      : typeof uri === "string"
        ? (uri.split(/[/?#]/).findLast(Boolean) ?? "download")
        : "download";
  // Path separators, reserved characters, and control characters.
  const safe = Array.from(raw, (char) =>
    /[\\/:*?"<>|]/.test(char) || char.charCodeAt(0) < 32 ? "-" : char,
  ).join("");
  return safe.slice(0, MAX_DOWNLOAD_NAME) || "download";
}

/** `ui/download-file` contents: MCP embedded resources and resource links. */
function readDownloads(contents: unknown): ReadonlyArray<McpAppDownload> | undefined {
  if (!Array.isArray(contents) || contents.length === 0) return undefined;
  const files: Array<McpAppDownload> = [];
  for (const entry of contents) {
    if (!Predicate.isObject(entry)) return undefined;
    if (entry.type === "resource" && Predicate.isObject(entry.resource)) {
      const resource = entry.resource;
      const bytes = mcpResourceBytes(resource);
      if (bytes === undefined) return undefined;
      files.push({
        _tag: "embedded",
        name: downloadName(resource.uri, resource.name),
        mimeType:
          typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream",
        bytes,
      });
    } else if (entry.type === "resource_link" && typeof entry.uri === "string") {
      files.push({
        _tag: "link",
        name: downloadName(entry.uri, entry.name),
        uri: entry.uri,
        ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
      });
    } else {
      return undefined;
    }
  }
  return files;
}

/**
 * Maps T3's resolved theme variables to the spec's standardized style names, so
 * apps written for any MCP Apps host pick up the thread's colors and fonts.
 */
export function mcpAppStyleVariables(
  theme: Readonly<Record<string, string>>,
): Record<string, string> {
  const pick = (name: string) => theme[name];
  const pairs: ReadonlyArray<readonly [string, string | undefined]> = [
    ["--color-background-primary", pick("--background")],
    ["--color-background-secondary", pick("--card")],
    ["--color-background-tertiary", pick("--muted")],
    ["--color-background-inverse", pick("--foreground")],
    ["--color-background-info", pick("--info")],
    ["--color-background-danger", pick("--destructive-surface")],
    ["--color-background-warning", pick("--warning-surface")],
    ["--color-text-primary", pick("--foreground")],
    ["--color-text-secondary", pick("--muted-foreground")],
    ["--color-text-tertiary", pick("--muted-foreground")],
    ["--color-text-inverse", pick("--background")],
    ["--color-text-info", pick("--info-foreground")],
    ["--color-text-danger", pick("--destructive-foreground")],
    ["--color-text-success", pick("--success-foreground")],
    ["--color-text-warning", pick("--warning-foreground")],
    ["--color-border-primary", pick("--border")],
    ["--color-border-secondary", pick("--input")],
    ["--color-border-danger", pick("--destructive")],
    ["--color-ring-primary", pick("--ring")],
    ["--font-sans", pick("--font-sans")],
    ["--font-mono", pick("--font-mono")],
    ["--border-radius-md", pick("--radius")],
  ];
  const variables: Record<string, string> = {};
  for (const [name, value] of pairs) {
    if (value !== undefined && value !== "") variables[name] = value;
  }
  return variables;
}
