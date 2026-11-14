// Runs as an external Service program: `node /app/echo-server.ts`.
// Node strips the types, so only erasable TypeScript syntax is allowed here.
import * as http from "node:http";

const ECHO_BODY = process.env.ECHO_BODY ?? "fly-echo";

const port = Number(process.env.PORT ?? 3000);

http
  .createServer((_request, response: http.ServerResponse) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(ECHO_BODY);
  })
  .listen(port, "0.0.0.0");
