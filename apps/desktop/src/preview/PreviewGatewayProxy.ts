// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Electron needs a native proxy with synchronous expiry checks.
import {
  PREVIEW_GATEWAY_HTTP_PATH,
  PREVIEW_GATEWAY_TARGET_HEADER,
  PREVIEW_GATEWAY_TICKET_HEADER,
  PREVIEW_GATEWAY_WEBSOCKET_PATH,
  parsePreviewGatewayTarget,
} from "@t3tools/shared/previewGateway";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";

export interface PreviewGatewayProxyConfiguration {
  readonly httpBaseUrl: string;
  readonly ticket: string;
  readonly port: number;
  readonly expiresAtEpochMilliseconds: number;
}

export interface PreviewGatewayProxy {
  readonly port: number;
  readonly configure: (configuration: PreviewGatewayProxyConfiguration) => void;
  readonly close: () => Promise<void>;
}

const HTTP_PROTOCOLS = new Set(["http:"]);
const WEBSOCKET_PROTOCOLS = new Set(["ws:"]);

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

const destroyDuplex = (socket: NodeStream.Duplex): void => {
  if (socket.destroyed) return;
  const resettable = socket as NodeStream.Duplex & { resetAndDestroy?: () => void };
  if (typeof resettable.resetAndDestroy === "function") {
    resettable.resetAndDestroy();
    return;
  }
  socket.destroy();
};

const forwardedHeaders = (headers: NodeHttp.IncomingHttpHeaders): NodeHttp.OutgoingHttpHeaders => {
  const connectionHeaders = new Set(
    headers.connection
      ?.split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const forwarded: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      normalized === "host" ||
      normalized === PREVIEW_GATEWAY_TICKET_HEADER ||
      normalized === PREVIEW_GATEWAY_TARGET_HEADER ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      connectionHeaders.has(normalized)
    ) {
      continue;
    }
    forwarded[name] = value;
  }
  return forwarded;
};

const responseHeaders = (headers: NodeHttp.IncomingHttpHeaders): NodeHttp.OutgoingHttpHeaders => {
  const forwarded: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      forwarded[name] = value;
    }
  }
  return forwarded;
};

const decodedRawResponseHeaders = (rawHeaders: ReadonlyArray<string>): ReadonlyArray<string> =>
  rawHeaders.filter((_, index) => {
    const name = rawHeaders[index - (index % 2)];
    return name === undefined || !HOP_BY_HOP_HEADERS.has(name.toLowerCase());
  });

const gatewayUrl = (httpBaseUrl: string, path: string): URL => {
  const url = new URL(httpBaseUrl);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
};

const gatewayRequest = (url: URL, options: NodeHttp.RequestOptions): NodeHttp.ClientRequest =>
  (url.protocol === "https:" ? NodeHttps : NodeHttp).request(url, options);

const sendHttpError = (
  response: NodeHttp.ServerResponse,
  statusCode: number,
  message: string,
): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(message);
};

const sendGatewayHttpError = (
  response: NodeHttp.ServerResponse,
  target: URL,
  message: string,
  code = "configuration-failed",
): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const port = target.port || "80";
  response.writeHead(502, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="t3-preview-gateway-error" content="${code}" data-port="${port}"><title>Preview unavailable</title></head><body><h1>Preview unavailable</h1><p>${message}</p></body></html>`,
  );
};

const writeRawResponse = (
  socket: NodeStream.Duplex,
  statusCode: number,
  statusMessage: string,
  rawHeaders: ReadonlyArray<string>,
): void => {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
};

const writeRawError = (socket: NodeStream.Duplex, statusCode: number, message: string): void => {
  const body = Buffer.from(message);
  socket.end(
    `HTTP/1.1 ${statusCode} ${NodeHttp.STATUS_CODES[statusCode] ?? "Error"}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Cache-Control: no-store\r\n" +
      `Content-Length: ${body.byteLength}\r\n` +
      "Connection: close\r\n\r\n" +
      body.toString(),
  );
};

export const startPreviewGatewayProxy = async (
  initialConfiguration: PreviewGatewayProxyConfiguration,
): Promise<PreviewGatewayProxy> => {
  const configurations = new Map<number, PreviewGatewayProxyConfiguration>([
    [initialConfiguration.port, initialConfiguration],
  ]);
  const configurationForTarget = (
    target: URL,
  ): { readonly configuration?: PreviewGatewayProxyConfiguration; readonly expired: boolean } => {
    const port = Number(target.port || "80");
    const configuration = configurations.get(port);
    if (!configuration) return { expired: false };
    if (configuration.expiresAtEpochMilliseconds <= Date.now()) {
      configurations.delete(port);
      return { expired: true };
    }
    return { configuration, expired: false };
  };
  const sockets = new Set<NodeStream.Duplex>();
  const server = NodeHttp.createServer((request, response) => {
    const target = parsePreviewGatewayTarget(request.url ?? "", HTTP_PROTOCOLS);
    if (!target) {
      sendHttpError(response, 400, "t3 preview proxy only accepts absolute loopback http targets");
      return;
    }
    const selected = configurationForTarget(target);
    if (!selected.configuration) {
      sendGatewayHttpError(
        response,
        target,
        selected.expired
          ? "the t3 preview gateway credential expired; navigate again to reconnect"
          : "this loopback port has not been authorized for remote preview",
        selected.expired ? "authentication-expired" : "configuration-failed",
      );
      return;
    }
    const configuration = selected.configuration;

    let upstream: NodeHttp.ClientRequest;
    try {
      const url = gatewayUrl(configuration.httpBaseUrl, PREVIEW_GATEWAY_HTTP_PATH);
      upstream = gatewayRequest(url, {
        method: request.method,
        headers: {
          ...forwardedHeaders(request.headers),
          [PREVIEW_GATEWAY_TICKET_HEADER]: configuration.ticket,
          [PREVIEW_GATEWAY_TARGET_HEADER]: target.href,
        },
      });
    } catch {
      sendGatewayHttpError(
        response,
        target,
        "t3 preview gateway configuration is invalid; reconnect the environment and try again",
      );
      return;
    }

    upstream.on("response", (gatewayResponse) => {
      response.writeHead(
        gatewayResponse.statusCode ?? 502,
        gatewayResponse.statusMessage,
        responseHeaders(gatewayResponse.headers),
      );
      NodeStream.pipeline(gatewayResponse, response, () => undefined);
    });
    upstream.on("error", () => {
      sendGatewayHttpError(
        response,
        target,
        "t3 preview gateway is unreachable; check the environment connection and try again",
      );
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const handleWebSocketUpgrade = (
    request: NodeHttp.IncomingMessage,
    browserSocket: NodeStream.Duplex,
    browserHead: Buffer,
    target: URL,
  ): void => {
    const selected = configurationForTarget(target);
    if (!selected.configuration) {
      writeRawError(
        browserSocket,
        selected.expired ? 401 : 403,
        selected.expired
          ? "the t3 preview gateway credential expired; navigate again to reconnect"
          : "this loopback port has not been authorized for remote preview",
      );
      return;
    }
    const configuration = selected.configuration;

    let upstream: NodeHttp.ClientRequest;
    try {
      const url = gatewayUrl(configuration.httpBaseUrl, PREVIEW_GATEWAY_WEBSOCKET_PATH);
      upstream = gatewayRequest(url, {
        method: "GET",
        headers: {
          ...forwardedHeaders(request.headers),
          connection: "Upgrade",
          upgrade: "websocket",
          [PREVIEW_GATEWAY_TICKET_HEADER]: configuration.ticket,
          [PREVIEW_GATEWAY_TARGET_HEADER]: target.href,
        },
      });
    } catch {
      writeRawError(
        browserSocket,
        502,
        "t3 preview gateway configuration is invalid; reconnect the environment and try again",
      );
      return;
    }

    upstream.on("upgrade", (gatewayResponse, gatewaySocket, gatewayHead) => {
      sockets.add(gatewaySocket);
      gatewaySocket.once("close", () => sockets.delete(gatewaySocket));
      writeRawResponse(
        browserSocket,
        gatewayResponse.statusCode ?? 101,
        gatewayResponse.statusMessage ?? "Switching Protocols",
        gatewayResponse.rawHeaders,
      );
      if (gatewayHead.byteLength > 0) browserSocket.write(gatewayHead);
      if (browserHead.byteLength > 0) gatewaySocket.write(browserHead);
      browserSocket.once("end", () => destroyDuplex(gatewaySocket));
      browserSocket.once("close", () => destroyDuplex(gatewaySocket));
      browserSocket.once("error", () => destroyDuplex(gatewaySocket));
      gatewaySocket.once("end", () => destroyDuplex(browserSocket));
      gatewaySocket.once("close", () => destroyDuplex(browserSocket));
      gatewaySocket.once("error", () => destroyDuplex(browserSocket));
      browserSocket.pipe(gatewaySocket);
      gatewaySocket.pipe(browserSocket);
    });
    upstream.on("response", (gatewayResponse) => {
      writeRawResponse(
        browserSocket,
        gatewayResponse.statusCode ?? 502,
        gatewayResponse.statusMessage ?? "Bad Gateway",
        decodedRawResponseHeaders(gatewayResponse.rawHeaders),
      );
      NodeStream.pipeline(gatewayResponse, browserSocket, () => undefined);
    });
    upstream.on("error", () => {
      writeRawError(
        browserSocket,
        502,
        "t3 preview gateway websocket is unreachable; check the environment connection and try again",
      );
    });
    browserSocket.once("close", () => upstream.destroy());
    upstream.end();
  };

  const tunnelTargets = new WeakMap<NodeStream.Duplex, URL>();
  const tunnelServer = NodeHttp.createServer((_request, response) => {
    response.shouldKeepAlive = false;
    sendHttpError(response, 400, "t3 preview websocket tunnels only accept upgrade requests");
  });
  tunnelServer.on("upgrade", (request, browserSocket, browserHead) => {
    const authority = tunnelTargets.get(browserSocket);
    tunnelTargets.delete(browserSocket);
    const path = request.url ?? "";
    if (!authority || request.method !== "GET" || !path.startsWith("/") || path.startsWith("//")) {
      writeRawError(browserSocket, 400, "t3 preview received an invalid websocket tunnel request");
      return;
    }
    handleWebSocketUpgrade(request, browserSocket, browserHead, new URL(path, authority));
  });

  server.on("connect", (request, socket, head) => {
    const target = parsePreviewGatewayTarget(`ws://${request.url ?? ""}/`, WEBSOCKET_PROTOCOLS);
    if (
      !target ||
      target.username.length > 0 ||
      target.password.length > 0 ||
      target.pathname !== "/" ||
      target.search.length > 0 ||
      target.hash.length > 0
    ) {
      writeRawError(socket, 400, "t3 preview proxy only accepts loopback websocket tunnels");
      return;
    }
    const selected = configurationForTarget(target);
    if (!selected.configuration) {
      writeRawError(
        socket,
        selected.expired ? 401 : 403,
        selected.expired
          ? "the t3 preview gateway credential expired; navigate again to reconnect"
          : "this loopback port has not been authorized for remote preview",
      );
      return;
    }
    socket.pause();
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    tunnelTargets.set(socket, target);
    tunnelServer.emit("connection", socket);
    if (head.byteLength > 0) socket.unshift(head);
    socket.resume();
  });

  server.on("upgrade", (request, browserSocket, browserHead) => {
    const target = parsePreviewGatewayTarget(request.url ?? "", WEBSOCKET_PROTOCOLS);
    if (!target) {
      writeRawError(
        browserSocket,
        400,
        "t3 preview proxy only accepts absolute loopback websocket targets",
      );
      return;
    }
    handleWebSocketUpgrade(request, browserSocket, browserHead, target);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error): void => {
      server.off("listening", onListening);
      reject(cause);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("t3 preview proxy did not receive a loopback port");
  }

  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    configure: (nextConfiguration) => {
      const now = Date.now();
      for (const [port, current] of configurations) {
        if (current.expiresAtEpochMilliseconds <= now) configurations.delete(port);
      }
      configurations.set(nextConfiguration.port, nextConfiguration);
    },
    close: () => {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((resolve, reject) => {
        for (const socket of sockets) destroyDuplex(socket);
        server.close((cause) => (cause ? reject(cause) : resolve()));
      });
      return closePromise;
    },
  };
};
