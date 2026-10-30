// @effect-diagnostics nodeBuiltinImport:off - Chromium needs a native HTTP proxy with CONNECT.
// A loopback HTTP proxy for one environment. Loopback destinations travel through authenticated
// byte tunnels to that environment and never fall back to this machine; other hosts go direct.
import { NodeWS } from "@effect/platform-node/NodeSocket";
import {
  REMOTE_PREVIEW_PROXY_GRANT_HEADER,
  REMOTE_PREVIEW_PROXY_TUNNEL_PATH,
  type RemotePreviewProxyDialHost,
  remotePreviewProxyDialHost,
} from "@t3tools/shared/remotePreviewProxy";
import * as NodeCrypto from "node:crypto";
import * as NodeDns from "node:dns";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as Schema from "effect/Schema";

export interface RemotePreviewProxyRoute {
  readonly httpBaseUrl: string;
  readonly grant: string;
  readonly ports: ReadonlySet<number>;
}

export type RemotePreviewProxyUnavailableReason = "not-configured" | "expired" | "revoked";

export type RemotePreviewProxyRouteState =
  | { readonly _tag: "Ready"; readonly route: RemotePreviewProxyRoute }
  | { readonly _tag: "Unavailable"; readonly reason: RemotePreviewProxyUnavailableReason };

class RemotePreviewProxyTunnelError extends Schema.TaggedError<RemotePreviewProxyTunnelError>()(
  "RemotePreviewProxyTunnelError",
  {
    reason: Schema.Literals([
      "port-not-approved",
      "grant-invalid",
      "upstream-unreachable",
      "environment-unreachable",
    ]),
    port: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Remote preview tunnel to port ${this.port} failed: ${this.reason}.`;
  }
}
type RemotePreviewProxyTunnelFailure = RemotePreviewProxyTunnelError["reason"];
const isTunnelError = Schema.is(RemotePreviewProxyTunnelError);

export interface RemotePreviewProxyServerOptions {
  readonly label: () => string;
  readonly state: () => RemotePreviewProxyRouteState;
  /** Basic `user:password` pairs currently allowed to use this proxy. */
  readonly credentials: () => ReadonlyArray<string>;
  readonly onDenied?: (port: number) => void;
  /** Called when the environment rejects the grant, so the owner can stop using it. */
  readonly onGrantRejected?: (grant: string) => void;
}

export interface RemotePreviewProxyServer {
  readonly port: number;
  /** Ends the tunnels a consumer opened with a credential that is no longer allowed. */
  readonly closeTunnelsFor: (credential: string) => void;
  /** Ends every tunnel and pooled connection; new requests read the current state. */
  readonly resetConnections: () => void;
  readonly close: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
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

const PROXY_REALM = 'Basic realm="T3 Code remote preview"';

const stripHopByHop = (headers: NodeHttp.IncomingHttpHeaders): NodeHttp.OutgoingHttpHeaders => {
  const listed = new Set(
    (headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const result: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) continue;
    result[name] = value;
  }
  return result;
};

const rawRequestHead = (request: NodeHttp.IncomingMessage, path: string): string => {
  const lines = [`${request.method ?? "GET"} ${path} HTTP/1.1`];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!;
    const lower = name.toLowerCase();
    if (lower === "proxy-authorization" || lower === "proxy-connection") continue;
    lines.push(`${name}: ${request.rawHeaders[index + 1]}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const unavailableMessage = (
  reason: RemotePreviewProxyUnavailableReason | RemotePreviewProxyTunnelFailure,
  port: number,
  label: string,
) => {
  switch (reason) {
    case "not-configured":
      return `T3 Code has not connected this preview to ${label} yet. Reconnect the environment and reload.`;
    case "expired":
      return `Access to ${label} expired. Reconnect the environment and reload.`;
    case "revoked":
      return `Remote preview access to ${label} was turned off.`;
    case "environment-unreachable":
      return `T3 Code cannot reach ${label}. Check the connection and reload.`;
    case "port-not-approved":
      return `Port ${port} on ${label} is not approved for this preview. Allow it from the browser menu, then reload.`;
    case "grant-invalid":
      return `${label} no longer accepts this preview's access. Reconnect the environment and reload.`;
    case "upstream-unreachable":
      return `Nothing is listening on port ${port} on ${label}.`;
  }
};

const statusFor = (
  reason: RemotePreviewProxyUnavailableReason | RemotePreviewProxyTunnelFailure,
) => (reason === "port-not-approved" ? 403 : reason === "upstream-unreachable" ? 502 : 503);

const sendErrorPage = (
  response: NodeHttp.ServerResponse,
  status: number,
  message: string,
  retry = false,
) => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  // Waiting states recover by themselves once the environment reconnects; the page retries.
  const refresh = retry ? '<meta http-equiv="refresh" content="5">' : "";
  const body = `<!doctype html><html><head><meta charset="utf-8">${refresh}<title>Preview unavailable</title></head><body><h1>Preview unavailable</h1><p>${escapeHtml(message)}</p></body></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
};

const recoversByItself = (
  reason: RemotePreviewProxyUnavailableReason | RemotePreviewProxyTunnelFailure,
) => reason === "not-configured" || reason === "expired" || reason === "environment-unreachable";

const writeRawError = (
  socket: NodeStream.Duplex,
  status: number,
  message: string,
  extraHeaders: ReadonlyArray<string> = [],
) => {
  const body = Buffer.from(message);
  socket.end(
    [
      `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status] ?? "Error"}`,
      "Content-Type: text/plain; charset=utf-8",
      "Cache-Control: no-store",
      `Content-Length: ${body.byteLength}`,
      "Connection: close",
      ...extraHeaders,
      "",
      message,
    ].join("\r\n"),
  );
};

/** The allowed `user:password` the request presented, or null. */
const authorizedCredential = (
  header: string | undefined,
  credentials: ReadonlyArray<string>,
): string | null => {
  const match = /^Basic\s+(.+)$/iu.exec(header?.trim() ?? "");
  if (!match) return null;
  const presented = Buffer.from(Buffer.from(match[1]!, "base64").toString("utf8"));
  let matched: string | null = null;
  for (const candidate of credentials) {
    const candidateBytes = Buffer.from(candidate);
    if (
      candidateBytes.byteLength === presented.byteLength &&
      NodeCrypto.timingSafeEqual(candidateBytes, presented)
    ) {
      matched = candidate;
    }
  }
  return matched;
};

type TunnelSocket = NodeStream.Duplex & {
  isPreviewTunnelOpen: () => boolean;
  setKeepAlive: () => TunnelSocket;
  setNoDelay: () => TunnelSocket;
  setTimeout: () => TunnelSocket;
  ref: () => TunnelSocket;
  unref: () => TunnelSocket;
};

/** Opens one byte tunnel to `host:port` on the environment's loopback. */
const openRemotePreviewTunnel = (
  route: RemotePreviewProxyRoute,
  host: RemotePreviewProxyDialHost,
  port: number,
): Promise<TunnelSocket> =>
  new Promise((resolve, reject) => {
    if (!route.ports.has(port)) {
      reject(new RemotePreviewProxyTunnelError({ reason: "port-not-approved", port }));
      return;
    }
    let url: URL;
    try {
      url = new URL(REMOTE_PREVIEW_PROXY_TUNNEL_PATH, route.httpBaseUrl);
    } catch (cause) {
      reject(new RemotePreviewProxyTunnelError({ reason: "environment-unreachable", port, cause }));
      return;
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("host", host);
    url.searchParams.set("port", String(port));
    const socket = new NodeWS.WebSocket(url, {
      headers: { [REMOTE_PREVIEW_PROXY_GRANT_HEADER]: route.grant },
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 15_000,
    });
    const fail = (error: RemotePreviewProxyTunnelError) => {
      socket.removeAllListeners("open");
      socket.terminate();
      reject(error);
    };
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      fail(
        new RemotePreviewProxyTunnelError({
          reason:
            status === 403
              ? "port-not-approved"
              : status === 401
                ? "grant-invalid"
                : status === 502
                  ? "upstream-unreachable"
                  : "environment-unreachable",
          port,
        }),
      );
    });
    socket.once("error", (cause) =>
      fail(new RemotePreviewProxyTunnelError({ reason: "environment-unreachable", port, cause })),
    );
    socket.once("open", () => {
      socket.removeAllListeners("error");
      const stream = NodeWS.createWebSocketStream(socket) as TunnelSocket;
      stream.on("error", () => stream.destroy());
      // A closed WebSocket may leave unread EOF on an idle duplex in http.Agent's pool.
      socket.once("close", () => stream.emit("agentRemove"));
      // http.Agent treats its connections as net.Sockets; tunnels have no TCP options to set.
      stream.isPreviewTunnelOpen = () => socket.readyState === socket.OPEN;
      stream.setKeepAlive = () => stream;
      stream.setNoDelay = () => stream;
      stream.setTimeout = () => stream;
      stream.ref = () => stream;
      stream.unref = () => stream;
      resolve(stream);
    });
  });

class TunnelAgent extends NodeHttp.Agent {
  readonly tunnelStates = new WeakMap<NodeStream.Duplex, () => boolean>();
  readonly host: RemotePreviewProxyDialHost;
  // Read per connection: a renewed grant applies to new tunnels without dropping pooled ones.
  readonly currentRoute: () => RemotePreviewProxyRoute | RemotePreviewProxyTunnelError;

  constructor(
    host: RemotePreviewProxyDialHost,
    currentRoute: () => RemotePreviewProxyRoute | RemotePreviewProxyTunnelError,
  ) {
    super({ keepAlive: true, maxSockets: 32 });
    this.host = host;
    this.currentRoute = currentRoute;
  }

  discardClosedTunnels() {
    for (const free of Object.values(this.freeSockets)) {
      for (const socket of free?.slice() ?? []) {
        if (this.tunnelStates.get(socket)?.() === false) {
          socket.emit("agentRemove");
          socket.destroy();
        }
      }
    }
  }

  override createConnection(
    options: NodeHttp.ClientRequestArgs,
    callback?: (error: Error | null, socket: NodeStream.Duplex) => void,
  ): NodeStream.Duplex | undefined {
    const route = this.currentRoute();
    const opened = isTunnelError(route)
      ? Promise.reject(route)
      : openRemotePreviewTunnel(route, this.host, Number(options.port));
    opened.then(
      (socket) => {
        this.tunnelStates.set(socket, socket.isPreviewTunnelOpen);
        callback?.(null, socket);
      },
      (error: Error) => callback?.(error, undefined as never),
    );
    return undefined;
  }
}

type Destination =
  | { readonly _tag: "Remote"; readonly host: RemotePreviewProxyDialHost }
  | { readonly _tag: "Direct"; readonly address: string; readonly family: number };

/**
 * Names that resolve to loopback here (`*.lvh.me`, `/etc/hosts` entries) are the environment's
 * loopback too; direct dials use the checked address so a second lookup cannot differ.
 */
const classifyDestination = async (hostname: string): Promise<Destination> => {
  const literal = remotePreviewProxyDialHost(hostname);
  if (literal !== null) return { _tag: "Remote", host: literal };
  const bare = hostname.replace(/^\[|\]$/gu, "");
  const resolved = NodeNet.isIP(bare)
    ? { address: bare, family: NodeNet.isIP(bare) }
    : await NodeDns.promises.lookup(bare);
  const loopback = remotePreviewProxyDialHost(resolved.address);
  return loopback === null
    ? { _tag: "Direct", address: resolved.address, family: resolved.family }
    : { _tag: "Remote", host: loopback };
};

const parseConnectAuthority = (authority: string): { host: string; port: number } | null => {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  return port > 0 && port < 65_536 ? { host: match[1]!.replace(/^\[|\]$/gu, ""), port } : null;
};

const pipeBoth = (
  a: NodeStream.Duplex,
  b: NodeStream.Duplex,
  sockets: Set<NodeStream.Duplex>,
  owned: Set<NodeStream.Duplex>,
) => {
  sockets.add(a);
  sockets.add(b);
  owned.add(a);
  const teardown = () => {
    a.destroy();
    b.destroy();
    sockets.delete(a);
    sockets.delete(b);
    owned.delete(a);
  };
  NodeStream.pipeline(a, b, teardown);
  NodeStream.pipeline(b, a, teardown);
};

export const startRemotePreviewProxyServer = async (
  options: RemotePreviewProxyServerOptions,
): Promise<RemotePreviewProxyServer> => {
  const sockets = new Set<NodeStream.Duplex>();
  const tunnelsByCredential = new Map<string, Set<NodeStream.Duplex>>();
  const tunnelsFor = (credential: string) => {
    const existing = tunnelsByCredential.get(credential);
    if (existing) return existing;
    const created = new Set<NodeStream.Duplex>();
    tunnelsByCredential.set(credential, created);
    return created;
  };
  const trackConsumer = (credential: string, socket: NodeStream.Duplex) => {
    const owned = tunnelsFor(credential);
    owned.add(socket);
    socket.once("close", () => {
      owned.delete(socket);
      if (owned.size === 0 && tunnelsByCredential.get(credential) === owned) {
        tunnelsByCredential.delete(credential);
      }
    });
  };
  const stillAuthorized = (credential: string, socket: NodeStream.Duplex) =>
    !socket.destroyed && options.credentials().includes(credential);
  let agents = new Map<RemotePreviewProxyDialHost, TunnelAgent>();
  const routeForAgent = (): RemotePreviewProxyRoute | RemotePreviewProxyTunnelError => {
    const state = options.state();
    return state._tag === "Ready"
      ? state.route
      : new RemotePreviewProxyTunnelError({ reason: "environment-unreachable", port: 0 });
  };
  const agentFor = (host: RemotePreviewProxyDialHost) => {
    const existing = agents.get(host);
    if (existing) {
      existing.discardClosedTunnels();
      return existing;
    }
    const created = new TunnelAgent(host, routeForAgent);
    agents.set(host, created);
    return created;
  };

  const resolveRemote = (
    port: number,
  ):
    | { readonly route: RemotePreviewProxyRoute }
    | {
        readonly failure: RemotePreviewProxyUnavailableReason | RemotePreviewProxyTunnelFailure;
      } => {
    const state = options.state();
    if (state._tag === "Unavailable") return { failure: state.reason };
    if (!state.route.ports.has(port)) {
      options.onDenied?.(port);
      return { failure: "port-not-approved" };
    }
    return { route: state.route };
  };

  const tunnelFailed = (error: unknown, route: RemotePreviewProxyRoute, port: number) => {
    const reason = isTunnelError(error) ? error.reason : "environment-unreachable";
    if (reason === "port-not-approved") options.onDenied?.(port);
    if (reason === "grant-invalid") options.onGrantRejected?.(route.grant);
    return reason;
  };

  /** A byte stream to `hostname:port`, or the error response to send instead. */
  const openStream = async (
    hostname: string,
    port: number,
  ): Promise<
    { readonly stream: NodeStream.Duplex } | { readonly status: number; readonly message: string }
  > => {
    const destination = await classifyDestination(hostname).catch(() => null);
    if (destination === null) return { status: 502, message: `Cannot resolve ${hostname}` };
    if (destination._tag === "Direct") {
      return new Promise((resolve) => {
        const direct = NodeNet.connect({
          host: destination.address,
          port,
          family: destination.family,
        });
        direct.once("connect", () => resolve({ stream: direct }));
        direct.once("error", () => resolve({ status: 502, message: `Cannot reach ${hostname}` }));
      });
    }
    const resolved = resolveRemote(port);
    if ("failure" in resolved) {
      return {
        status: statusFor(resolved.failure),
        message: unavailableMessage(resolved.failure, port, options.label()),
      };
    }
    return openRemotePreviewTunnel(resolved.route, destination.host, port).then(
      (stream) => ({ stream }),
      (error: unknown) => {
        const reason = tunnelFailed(error, resolved.route, port);
        return {
          status: statusFor(reason),
          message: unavailableMessage(reason, port, options.label()),
        };
      },
    );
  };

  const server = NodeHttp.createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("request", (request, response) => {
    const credential = authorizedCredential(
      request.headers["proxy-authorization"],
      options.credentials(),
    );
    if (credential === null) {
      response.writeHead(407, { "proxy-authenticate": PROXY_REALM, "content-length": 0 });
      response.end();
      return;
    }
    trackConsumer(credential, request.socket);
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      sendErrorPage(response, 400, "T3 Code's preview proxy only accepts proxy requests.");
      return;
    }
    if (target.protocol !== "http:") {
      sendErrorPage(response, 400, "T3 Code's preview proxy only forwards http URLs in this form.");
      return;
    }
    const port = Number(target.port || 80);
    void classifyDestination(target.hostname).then(
      (destination) => {
        if (!stillAuthorized(credential, request.socket)) {
          response.destroy();
          return;
        }
        forwardRequest(request, response, target, port, destination);
      },
      () => sendErrorPage(response, 502, `T3 Code could not resolve ${target.hostname}.`),
    );
  });

  const forwardRequest = (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    target: URL,
    port: number,
    destination: Destination,
  ) => {
    let agent: NodeHttp.Agent | undefined;
    let route: RemotePreviewProxyRoute | null = null;
    if (destination._tag === "Remote") {
      const resolved = resolveRemote(port);
      if ("failure" in resolved) {
        sendErrorPage(
          response,
          statusFor(resolved.failure),
          unavailableMessage(resolved.failure, port, options.label()),
          recoversByItself(resolved.failure),
        );
        request.resume();
        return;
      }
      route = resolved.route;
      agent = agentFor(destination.host);
    }
    const upstream = NodeHttp.request({
      // A tunnel dials the environment's loopback; the Host header keeps the page's origin.
      host: destination._tag === "Remote" ? destination.host : destination.address,
      port,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...stripHopByHop(request.headers), host: target.host },
      ...(agent === undefined ? {} : { agent }),
    });
    upstream.on("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        stripHopByHop(upstreamResponse.headers),
      );
      // A premature upstream close destroys the browser response instead of leaving it open.
      NodeStream.pipeline(upstreamResponse, response, () => undefined);
    });
    upstream.on("error", (error) => {
      if (route === null) {
        sendErrorPage(response, 502, `T3 Code could not reach ${target.host}.`);
        return;
      }
      const reason = tunnelFailed(error, route, port);
      sendErrorPage(
        response,
        statusFor(reason),
        unavailableMessage(reason, port, options.label()),
        recoversByItself(reason),
      );
    });
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    NodeStream.pipeline(request, upstream, () => undefined);
  };

  server.on("connect", (request, socket: NodeStream.Duplex, head) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    const credential = authorizedCredential(
      request.headers["proxy-authorization"],
      options.credentials(),
    );
    if (credential === null) {
      writeRawError(socket, 407, "Proxy authentication required", [
        `Proxy-Authenticate: ${PROXY_REALM}`,
      ]);
      return;
    }
    trackConsumer(credential, socket);
    const authority = parseConnectAuthority(request.url ?? "");
    if (authority === null) {
      writeRawError(socket, 400, "Invalid CONNECT authority");
      return;
    }
    const established = (upstream: NodeStream.Duplex) => {
      if (!stillAuthorized(credential, socket)) {
        upstream.destroy();
        socket.destroy();
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength > 0) upstream.write(head);
      pipeBoth(socket, upstream, sockets, tunnelsFor(credential));
    };
    void openStream(authority.host, authority.port).then((opened) => {
      if ("stream" in opened) established(opened.stream);
      else writeRawError(socket, opened.status, opened.message);
    });
  });

  // Absolute-form upgrades; Chromium itself tunnels WebSockets with CONNECT.
  server.on("upgrade", (request, socket: NodeStream.Duplex, head) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    const credential = authorizedCredential(
      request.headers["proxy-authorization"],
      options.credentials(),
    );
    if (credential === null) {
      writeRawError(socket, 407, "Proxy authentication required", [
        `Proxy-Authenticate: ${PROXY_REALM}`,
      ]);
      return;
    }
    trackConsumer(credential, socket);
    let target: URL;
    try {
      target = new URL((request.url ?? "").replace(/^ws:/u, "http:"));
    } catch {
      writeRawError(socket, 400, "Invalid upgrade target");
      return;
    }
    if (target.protocol !== "http:") {
      writeRawError(socket, 400, "Invalid upgrade target");
      return;
    }
    const port = Number(target.port || 80);
    const forward = (upstream: NodeStream.Duplex) => {
      upstream.write(rawRequestHead(request, `${target.pathname}${target.search}`));
      if (head.byteLength > 0) upstream.write(head);
      pipeBoth(socket, upstream, sockets, tunnelsFor(credential));
    };
    void openStream(target.hostname, port).then((opened) => {
      if (!("stream" in opened)) {
        writeRawError(socket, opened.status, opened.message);
        return;
      }
      if (!stillAuthorized(credential, socket)) {
        opened.stream.destroy();
        socket.destroy();
        return;
      }
      forward(opened.stream);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The remote preview proxy did not get a loopback port.");
  }

  const resetConnections = () => {
    for (const agent of agents.values()) agent.destroy();
    agents = new Map();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    closeTunnelsFor: (credential) => {
      for (const socket of tunnelsByCredential.get(credential) ?? []) socket.destroy();
      tunnelsByCredential.delete(credential);
    },
    resetConnections,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        resetConnections();
        server.close(() => resolve());
      });
      return closing;
    },
  };
};
