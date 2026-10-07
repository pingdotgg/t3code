// Runs inside each Fly container via `node --input-type=module-typescript -e`;
// Node strips the types, so only erasable TypeScript syntax is allowed here.
import * as http from "node:http";

const port = Number(process.env.PORT);
const name = process.env.CONTAINER_NAME;
const version = process.env.VERSION;
const machine = process.env.FLY_MACHINE_ID;
const held = new Set<http.ServerResponse>();
const receipt = (signal: string) =>
  JSON.stringify({ machine, name, version, signal });
const server = http.createServer((request, response) => {
  response.setHeader("cache-control", "no-store");
  if (request.url === "/health") {
    const ready = process.env.BAD_HEALTH !== "true";
    response.writeHead(ready ? 200 : 503).end();
  } else if (request.url === "/sidecar/hold") {
    const proxy = http.get("http://127.0.0.1:3001/hold", (upstream) => {
      response.writeHead(upstream.statusCode ?? 502);
      upstream.pipe(response);
    });
    proxy.on("error", () => response.destroy());
    response.on("close", () => proxy.destroy());
  } else if (request.url === "/hold") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("waiting\n");
    held.add(response);
    response.on("close", () => held.delete(response));
    // A broken shutdown cannot leave a request alive indefinitely.
    const deadline = setTimeout(() => response.destroy(), 90_000);
    response.on("close", () => clearTimeout(deadline));
  } else if (request.url === "/") {
    response.end(version);
  } else {
    response.writeHead(404).end();
  }
});
server.listen(port, "::");
process.once("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => {
    for (const response of held) response.end(receipt("SIGTERM"));
  }, 1000);
});
