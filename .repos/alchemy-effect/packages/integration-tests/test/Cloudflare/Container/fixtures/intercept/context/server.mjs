// Probe server for the outbound-interception test. Plain node, no deps.
// `/probe?url=<url>` fetches <url> from INSIDE the container and reports what
// came back. The container has no internet, so only the owning Durable
// Object's interception can answer.
import * as http from "node:http";

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const url = new URL(req.url, "http://container");
  if (url.pathname === "/probe") {
    try {
      const response = await fetch(url.searchParams.get("url"));
      const body = await response.text();
      res.end(JSON.stringify({ status: response.status, body }));
    } catch (error) {
      res.end(JSON.stringify({ error: String(error.cause ?? error) }));
    }
    return;
  }
  res.end(JSON.stringify({ ok: true }));
});

server.listen(8080, () => {
  console.log("intercept probe server listening on 8080");
});
