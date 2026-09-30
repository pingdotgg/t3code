import * as Crypto from "node:crypto";
import * as Http from "node:http";
import * as Https from "node:https";
import type { Duplex } from "node:stream";
import type { ConnectAccountDriver, DesktopConnectTarget } from "@t3tools/shared/desktopConnect";
import { createConnectAccountBroker } from "./connectAccountBroker.ts";

export const CONNECT_ACCOUNT_SCHEME = "t3-connect";

export function createConnectAccountTransport(input: {
  readonly driver: ConnectAccountDriver;
  readonly trustedOrigin: () => string;
  readonly onInvalidated: () => void;
}) {
  const broker = createConnectAccountBroker(input.driver);
  const routes = new Map<
    string,
    {
      accountId: string;
      environmentId: string;
      target: DesktopConnectTarget;
    }
  >();
  const tickets = new Map<string, { route: string; expiresAt: number }>();
  const sockets = new Set<Duplex>();
  const requests = new Set<AbortController>();
  let port: number | undefined;
  let starting: Promise<void> | undefined;

  const invalidate = () => {
    routes.clear();
    tickets.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const controller of requests) controller.abort();
    requests.clear();
    input.onInvalidated();
  };
  broker.subscribeInvalidation(invalidate);
  const issueTicket = (route: string) => {
    const now = Date.now();
    for (const [ticket, value] of tickets) {
      if (value.expiresAt <= now) tickets.delete(ticket);
    }
    const ticket = Crypto.randomBytes(32).toString("base64url");
    tickets.set(ticket, { route, expiresAt: now + 30_000 });
    return ticket;
  };
  const server = Http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const ticket = url.searchParams.get("wsTicket") ?? "";
    const capability = tickets.get(ticket);
    tickets.delete(ticket);
    const id = capability?.route;
    const route = id ? routes.get(id) : undefined;
    if (
      !id ||
      !route ||
      capability?.route !== id ||
      capability.expiresAt <= Date.now() ||
      request.headers.origin !== input.trustedOrigin()
    ) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    void route.target
      .nextSocketUrl()
      .then((authorized) => {
        if (socket.destroyed || routes.get(id) !== route) {
          socket.destroy();
          return;
        }
        const upstream = new URL(authorized);
        upstream.protocol = upstream.protocol === "wss:" ? "https:" : "http:";
        upstream.pathname = url.pathname.startsWith(`/${id}/`)
          ? url.pathname.slice(id.length + 1)
          : url.pathname;
        for (const [key, value] of url.searchParams) {
          if (key !== "wsTicket") upstream.searchParams.set(key, value);
        }
        const upgrade = (upstream.protocol === "https:" ? Https : Http).request(upstream, {
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": request.headers["sec-websocket-key"] ?? "",
            "sec-websocket-version": "13",
            ...(request.headers["sec-websocket-protocol"]
              ? { "sec-websocket-protocol": request.headers["sec-websocket-protocol"] }
              : {}),
          },
        });
        upgrade.setTimeout(10_000, () => upgrade.destroy());
        socket.once("close", () => upgrade.destroy());
        upgrade.on("error", () => socket.destroy());
        upgrade.on("response", (response) => {
          response.destroy();
          socket.destroy();
        });
        upgrade.on("upgrade", (response, remote, remoteHead) => {
          remote.setTimeout(0);
          if (socket.destroyed || routes.get(id) !== route) {
            remote.destroy();
            socket.destroy();
            return;
          }
          sockets.add(remote);
          remote.on("error", () => socket.destroy());
          remote.on("close", () => {
            sockets.delete(remote);
            socket.destroy();
          });
          socket.on("close", () => remote.destroy());
          const headers = response.rawHeaders.reduce<string[]>((lines, value, index, values) => {
            if (index % 2 === 0) lines.push(`${value}: ${values[index + 1]}`);
            return lines;
          }, []);
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
          if (remoteHead.length) socket.write(remoteHead);
          if (head.length) remote.write(head);
          remote.pipe(socket).pipe(remote);
        });
        upgrade.end();
      })
      .catch(() => socket.destroy());
  });
  const start = () =>
    (starting ??= new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not start desktop account transport."));
          return;
        }
        port = address.port;
        server.unref();
        resolve();
      });
    }));

  return {
    discover: broker.discover,
    login: broker.login,
    logout: broker.logout,
    async connect(accountId: string, environmentId: string) {
      await start();
      let existing = [...routes].find(
        ([, route]) => route.accountId === accountId && route.environmentId === environmentId,
      );
      if (!existing) {
        const target = await broker.connect(accountId, environmentId);
        const id = Crypto.randomUUID();
        const route = { accountId, environmentId, target };
        routes.set(id, route);
        existing = [id, route];
      }
      const [id] = existing;
      return {
        environmentId,
        httpBaseUrl: `${CONNECT_ACCOUNT_SCHEME}://${id}`,
        wsBaseUrl: `ws://127.0.0.1:${port}/${id}/ws`,
      };
    },
    async socketUrl(accountId: string, environmentId: string) {
      const [id] =
        [...routes].find(
          ([, route]) => route.accountId === accountId && route.environmentId === environmentId,
        ) ?? [];
      if (!id) throw new Error("Account environment is not connected.");
      return `ws://127.0.0.1:${port}/${id}/ws?wsTicket=${issueTicket(id)}`;
    },
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const origin = input.trustedOrigin();
      const source =
        request.headers.get("origin") ?? request.headers.get("referer") ?? request.referrer;
      let trusted = false;
      try {
        trusted = new URL(source).origin === origin;
      } catch {
        trusted = false;
      }
      if (!trusted) return new Response("Forbidden", { status: 403 });
      const headers = {
        "cache-control": "no-store",
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, range, if-match, if-none-match",
      };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const route = routes.get(url.hostname);
      if (!route) return new Response("Account environment disconnected", { status: 401, headers });
      if (url.pathname === "/api/auth/websocket-ticket" && request.method === "POST") {
        return Response.json(
          {
            ticket: issueTicket(url.hostname),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          },
          { headers },
        );
      }
      const controller = new AbortController();
      requests.add(controller);
      request.signal.addEventListener("abort", () => controller.abort(), { once: true });
      try {
        url.searchParams.delete("wsTicket");
        const upstream = await route.target.request(
          `${url.pathname}${url.search}`,
          new Request(request, { signal: controller.signal }),
        );
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.delete("set-cookie");
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        for (const [key, value] of Object.entries(headers)) responseHeaders.set(key, value);
        const reader = upstream.body?.getReader();
        const body = reader
          ? new ReadableStream<Uint8Array>({
              async pull(output) {
                try {
                  const next = await reader.read();
                  if (next.done) {
                    requests.delete(controller);
                    output.close();
                  } else output.enqueue(next.value);
                } catch (error) {
                  requests.delete(controller);
                  output.error(error);
                }
              },
              async cancel() {
                requests.delete(controller);
                controller.abort();
                await reader.cancel();
              },
            })
          : null;
        if (!reader) requests.delete(controller);
        return new Response(body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      } catch {
        requests.delete(controller);
        return new Response("Could not authorize the account environment.", {
          status: 502,
          headers,
        });
      }
    },
    dispose() {
      invalidate();
      server.close();
    },
  };
}
