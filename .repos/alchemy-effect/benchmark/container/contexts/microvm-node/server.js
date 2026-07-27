// Dumbest possible node HTTP server — the node cold-start baseline. Mirrors the
// effectful Sandbox's two routes (`/echo` and a default text response) so the
// in-VM workload is identical; everything that differs in time-to-usable is the
// alchemy/Effect abstraction, not the work the server does.
const http = require("node:http");

const port = Number(process.env.PORT ?? 8080);

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://microvm");
    if (url.pathname === "/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: url.searchParams.get("message") ?? "" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from node microvm");
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`node microvm baseline listening on :${port}`);
  });
