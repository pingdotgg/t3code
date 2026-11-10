// A prebuilt server deployed as-is (`bundle: false`), like a framework's
// standalone output. Lambda starts this file; it listens where Lambda says.
import * as http from "node:http";
import { greeting } from "./greeting.mjs";

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000").split(":");

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${greeting} on ${host}:${port}`);
  })
  .listen(Number(port), host);
