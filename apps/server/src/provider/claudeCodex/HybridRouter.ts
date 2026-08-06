// @effect-diagnostics nodeBuiltinImport:off
/**
 * Loopback-only Anthropic/Codex request router (fork feature f5).
 *
 * Claude Code keeps authenticating ordinary Claude requests itself. Only
 * requests whose JSON body names a verified Codex model are redirected to the
 * local compatibility proxy. A random capability path prevents unrelated
 * local processes from using the router as an authenticated Anthropic relay.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

const http = NodeHttp;
const https = NodeHttps;
const randomBytes = NodeCrypto.randomBytes;

const MAX_MESSAGE_REQUEST_BYTES = 64 * 1024 * 1024;
const ANTHROPIC_ORIGIN = new URL("https://api.anthropic.com");
const CLAUDE_MODEL_ALIASES = new Set(["claude", "sonnet", "opus", "opusplan", "haiku", "fable"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ClaudeCodexHybridRouterDeps {
  readonly codexUpstream: () => { readonly port: number; readonly token: string } | null;
  readonly onCodexUnavailable?: (() => void) | undefined;
  readonly isCodexModel: (modelId: string) => boolean;
  /** Ordinary Claude traffic keeps the instance's original API origin. */
  readonly anthropicUpstream?: URL | undefined;
}

export function classifyClaudeCodexUpstream(
  model: string | undefined,
  isCodexModel: (modelId: string) => boolean,
): "codex" | "anthropic" | "reject" {
  const normalized = model?.trim();
  if (!normalized) return "reject";
  if (isCodexModel(normalized)) return "codex";
  const base = normalized.replace(/\[1m\]$/u, "").toLowerCase();
  if (base.startsWith("claude-") || CLAUDE_MODEL_ALIASES.has(base)) return "anthropic";
  return "reject";
}

export function claudeCodexUpstreamPath(basePath: string, requestPath: string): string {
  const prefix = basePath === "/" ? "" : basePath.replace(/\/$/u, "");
  return `${prefix}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`;
}

function headersWithoutHopByHop(
  headers: NodeHttp.IncomingHttpHeaders,
): NodeHttp.OutgoingHttpHeaders {
  const stripped: NodeHttp.OutgoingHttpHeaders = { ...headers };
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) delete stripped[name];
  return stripped;
}

function sendJsonError(
  response: NodeHttp.ServerResponse,
  status: number,
  message: string,
  error?: Error,
): void {
  try {
    if (response.headersSent || response.destroyed) {
      response.destroy(error);
      return;
    }
    const body = Buffer.from(JSON.stringify({ error: message }));
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": body.length,
    });
    response.end(body);
  } catch {
    try {
      response.destroy(error);
    } catch {
      // The socket is already gone.
    }
  }
}

export class ClaudeCodexHybridRouter {
  readonly #secret = randomBytes(32).toString("hex");
  readonly #deps: ClaudeCodexHybridRouterDeps;
  #server: NodeHttp.Server | null = null;
  #url: string | null = null;

  constructor(deps: ClaudeCodexHybridRouterDeps) {
    this.#deps = deps;
  }

  baseUrl(): string | null {
    return this.#url;
  }

  start(): Promise<string> {
    this.stop();
    return new Promise((resolve, reject) => {
      let listening = false;
      const server = http.createServer((request, response) => {
        response.on("error", () => undefined);
        try {
          this.#handleRequest(request, response);
        } catch (cause) {
          sendJsonError(
            response,
            502,
            "Claude/Codex router request failed.",
            cause instanceof Error ? cause : undefined,
          );
        }
      });
      this.#server = server;
      server.on("clientError", (_error, socket) => {
        socket.on("error", () => undefined);
        try {
          if (socket.writable) {
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          }
        } catch {
          // Best-effort malformed-client cleanup.
        }
      });
      server.on("error", (error) => {
        if (listening) return;
        if (this.#server === server) {
          this.#server = null;
          this.#url = null;
        }
        reject(error);
      });
      try {
        server.listen(0, "127.0.0.1", () => {
          listening = true;
          if (this.#server !== server) {
            server.close();
            reject(new Error("Claude/Codex router stopped during startup."));
            return;
          }
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : 0;
          if (!port) {
            this.stop();
            reject(new Error("Claude/Codex router could not bind a loopback port."));
            return;
          }
          this.#url = `http://127.0.0.1:${port}/x/${this.#secret}`;
          resolve(this.#url);
        });
      } catch (cause) {
        if (this.#server === server) this.stop();
        reject(cause);
      }
    });
  }

  stop(): void {
    const server = this.#server;
    this.#server = null;
    this.#url = null;
    if (!server) return;
    try {
      server.close();
      server.closeAllConnections();
    } catch {
      // Best-effort shutdown.
    }
  }

  #handleRequest(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse): void {
    let parsed: URL;
    try {
      parsed = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJsonError(response, 403, "Forbidden.");
      return;
    }
    const capabilityPath = `/x/${this.#secret}`;
    if (
      parsed.pathname === capabilityPath &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      response.writeHead(200, { "content-length": "0" });
      response.end();
      return;
    }
    if (!parsed.pathname.startsWith(`${capabilityPath}/`)) {
      sendJsonError(response, 403, "Forbidden.");
      return;
    }

    const realPathname = parsed.pathname.slice(capabilityPath.length);
    const realPath = `${realPathname}${parsed.search}`;
    const isMessageRequest = request.method === "POST" && realPathname === "/v1/messages";
    const hasJsonBody =
      request.method === "POST" &&
      /(?:^|[+/])json(?:;|$)/iu.test(String(request.headers["content-type"] ?? ""));
    if (!isMessageRequest && !hasJsonBody) {
      this.#forward(request, response, realPath, "anthropic");
      return;
    }

    const chunks: Array<Buffer> = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > MAX_MESSAGE_REQUEST_BYTES) {
        rejected = true;
        chunks.length = 0;
        sendJsonError(response, 413, "Claude/Codex router request was too large.");
        return;
      }
      chunks.push(data);
    });
    request.once("error", (error) => {
      if (!rejected) sendJsonError(response, 400, "Request body could not be read.", error);
    });
    request.once("end", () => {
      if (rejected || response.destroyed) return;
      const body = Buffer.concat(chunks, size);
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        sendJsonError(response, 400, "Request body was not valid JSON.");
        return;
      }
      const model =
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof (payload as { model?: unknown }).model === "string"
          ? (payload as { model: string }).model
          : undefined;
      const upstream = isMessageRequest
        ? classifyClaudeCodexUpstream(model, this.#deps.isCodexModel)
        : "anthropic";
      if (upstream === "reject") {
        sendJsonError(response, 400, `Unsupported routed model: ${model?.trim() || "unknown"}.`);
        return;
      }
      this.#forward(request, response, realPath, upstream, body);
    });
  }

  #forward(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    path: string,
    upstream: "codex" | "anthropic",
    body?: Buffer,
  ): void {
    try {
      const headers = headersWithoutHopByHop(request.headers);
      let target: URL;
      if (upstream === "codex") {
        const codex = this.#deps.codexUpstream();
        if (!codex) {
          this.#deps.onCodexUnavailable?.();
          sendJsonError(response, 502, "Codex bridge is not available.");
          return;
        }
        target = new URL(`http://127.0.0.1:${codex.port}`);
        delete headers.authorization;
        delete headers["x-api-key"];
        headers.authorization = `Bearer ${codex.token}`;
      } else {
        target = this.#deps.anthropicUpstream ?? ANTHROPIC_ORIGIN;
      }
      headers.host = target.host;
      if (body) {
        delete headers["transfer-encoding"];
        headers["content-length"] = String(body.length);
      }

      const upstreamPath = claudeCodexUpstreamPath(
        upstream === "anthropic" ? target.pathname : "/",
        path,
      );
      const transport = target.protocol === "https:" ? https : http;
      const upstreamRequest = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: request.method,
          path: upstreamPath,
          headers,
        },
        (upstreamResponse) => {
          upstreamResponse.once("error", (error) =>
            sendJsonError(response, 502, "Upstream response failed.", error),
          );
          if (response.destroyed) {
            upstreamResponse.destroy();
            return;
          }
          try {
            response.writeHead(
              upstreamResponse.statusCode ?? 502,
              headersWithoutHopByHop(upstreamResponse.headers),
            );
            upstreamResponse.pipe(response);
          } catch (cause) {
            upstreamResponse.destroy();
            response.destroy(cause instanceof Error ? cause : undefined);
          }
        },
      );
      upstreamRequest.once("error", (error) =>
        sendJsonError(response, 502, "Upstream is unavailable.", error),
      );
      request.once("aborted", () => upstreamRequest.destroy());
      response.once("close", () => {
        if (!response.writableEnded) upstreamRequest.destroy();
      });
      if (body !== undefined) upstreamRequest.end(body);
      else request.pipe(upstreamRequest);
    } catch (cause) {
      sendJsonError(
        response,
        502,
        "Claude/Codex router request forwarding failed.",
        cause instanceof Error ? cause : undefined,
      );
    }
  }
}
