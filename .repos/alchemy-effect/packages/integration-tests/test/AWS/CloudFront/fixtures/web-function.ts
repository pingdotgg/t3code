// A Lambda Web Function origin. It echoes what reached it so the test can
// confirm CloudFront forwards the whole viewer request (method, query,
// body, the application's own Authorization header) while signing the
// origin request itself.
import * as http from "node:http";

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000").split(":");

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let body: string | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = Buffer.concat(chunks).toString("utf8");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        message: "hello through cloudfront",
        method: req.method,
        query: url.search,
        body,
        endpoint: req.headers["lambda-web-endpoint-name"] ?? null,
        authorization: req.headers.authorization ?? null,
      }),
    );
  })
  .listen(Number(port), host);
