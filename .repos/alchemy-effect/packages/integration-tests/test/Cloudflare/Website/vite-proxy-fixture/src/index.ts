export default {
  async fetch(request: Request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/worker-ws" && request.headers.get("upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (event) => server.send(`worker ${event.data}`));
      server.addEventListener("close", (event) => server.close(event.code, event.reason));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.headers.get("upgrade") === "websocket") {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(`worker ${pathname}`);
  },
};
