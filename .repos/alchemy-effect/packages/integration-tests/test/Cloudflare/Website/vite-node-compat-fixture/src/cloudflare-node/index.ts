import http from "node:http";
import { httpServerHandler } from "cloudflare:node";

const server = http.createServer((_, res) => {
  res.end("Hello from an httpServerHandler");
});

server.listen(8080);
export default httpServerHandler({ port: 8080 });
