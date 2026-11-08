// Minimal fetch-shaped HTTP server so the PKJS tests run under Vitest without Bun.
import * as NodeHttp from "node:http";

export interface TestRequest {
  method: string;
  url: string;
  path: string;
  headers: Headers;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

export interface TestResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

export function json(value: unknown, init: TestResponse = {}): TestResponse {
  return {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(value),
  };
}

export function text(body: string, init: TestResponse = {}): TestResponse {
  return { ...init, body };
}

export async function serve(
  handler: (request: TestRequest) => TestResponse | Promise<TestResponse>,
) {
  const server = NodeHttp.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      try {
        const result = await handler({
          method: incoming.method ?? "GET",
          url: incoming.url ?? "/",
          path: new URL(incoming.url ?? "/", "http://127.0.0.1").pathname,
          headers,
          text: async () => raw,
          json: async () => JSON.parse(raw),
        });
        outgoing.writeHead(result.status ?? 200, result.headers);
        outgoing.end(result.body);
      } catch (error) {
        outgoing.writeHead(500);
        outgoing.end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return {
    port: address.port,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}
