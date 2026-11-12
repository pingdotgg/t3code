// An async Web Function: a plain Node server, deployed as-is. It listens
// where Lambda says, the same way any Express, Hono, or Fastify app would.
import { Resolver } from "node:dns/promises";
import * as http from "node:http";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readBody = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const json = (res: http.ServerResponse, value: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000").split(":");

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      for (const [i, chunk] of ["one\n", "two\n", "three\n"].entries()) {
        if (i > 0) await sleep(600);
        res.write(chunk);
      }
      res.end();
      return;
    }

    if (url.pathname === "/dns") {
      // Query a specific DNS server, e.g. a VPC's Amazon-provided resolver,
      // which is only reachable from inside that VPC.
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers([url.searchParams.get("server")!]);
      try {
        const addresses = await resolver.resolve4(url.searchParams.get("name") ?? "aws.amazon.com");
        return json(res, { ok: true, addresses });
      } catch (error) {
        return json(res, { ok: false, error: String(error) });
      }
    }

    if (url.pathname === "/endpoint") {
      // Lambda sets this header; callers can't forge it.
      res.end(req.headers["lambda-web-endpoint-name"] ?? "missing");
      return;
    }

    if (url.pathname === "/echo" && req.method === "POST") {
      return json(res, { method: req.method, body: await readBody(req) });
    }

    res.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": "a=1",
      "x-fixture": "async-server",
      // Alchemy doesn't wrap the server or set listen variables for it.
      "x-port-env": process.env.PORT ?? "unset",
    });
    res.end(`greeting=${process.env.GREETING ?? "missing"}`);
  })
  .listen(Number(port), host);
