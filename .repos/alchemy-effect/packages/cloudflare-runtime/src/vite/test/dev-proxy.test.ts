import * as fs from "node:fs/promises";
import * as NodeHttp from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { URL as NodeURL } from "node:url";
import * as vite from "vite";
import { expect, onTestFinished, test, vi } from "vitest";
import cloudflareVitePlugin from "../plugin.ts";
import { forwardWorkerRequest } from "../worker-request.ts";

// Starts a dev server for a Worker whose module source is `source`.
const devServer = async (source: string): Promise<string> => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  // Only the local runtime is used; no Cloudflare API calls are made.
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-proxy-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "worker.js");
  await fs.writeFile(entry, source);
  const server = await vite.createServer({
    root,
    configFile: false,
    cacheDir: path.join(root, ".vite"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      cloudflareVitePlugin({ main: entry, worker: { name: "vite-dev-proxy-test", bindings: [] } }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  return server.resolvedUrls!.local[0]!;
};

// Sends a request with `node:http`, which, unlike `fetch`, can pin requests to
// one kept-alive connection.
const send = (
  url: URL,
  options: { agent: NodeHttp.Agent | false; method?: string; body?: Buffer },
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = NodeHttp.request(url.href, {
      agent: options.agent,
      method: options.method ?? "GET",
      signal: AbortSignal.timeout(10_000),
    });
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
      );
    });
    request.end(options.body);
  });

// Listens on a free loopback port until the test finishes.
const listen = async (server: NodeHttp.Server): Promise<NodeURL> => {
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return new NodeURL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
};

// Proxies every request to `runtime` the way the dev server does.
const proxyTo = (runtime: NodeURL): Promise<NodeURL> => {
  const logger = vite.createLogger("silent");
  return listen(
    NodeHttp.createServer((request, response) => {
      forwardWorkerRequest(request, response, runtime, "secret", logger);
    }),
  );
};

test("stops the Worker's stream when the client hangs up", async () => {
  // An endless event stream, like a page's SSE subscription, counting the
  // chunks it is asked for.
  const url = await devServer(`
    const encoder = new TextEncoder();
    let pulls = 0;
    export default {
      fetch(request) {
        if (new URL(request.url).pathname === "/pulls") {
          return Response.json({ pulls });
        }
        return new Response(
          new ReadableStream({
            async pull(controller) {
              pulls++;
              await new Promise((resolve) => setTimeout(resolve, 50));
              controller.enqueue(encoder.encode("data: tick\\n\\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    };
  `);
  const pulls = async () => {
    const response = await fetch(new URL("/pulls", url), { signal: AbortSignal.timeout(5_000) });
    return ((await response.json()) as { pulls: number }).pulls;
  };

  const client = new AbortController();
  const stream = await fetch(new URL("/events", url), { signal: client.signal });
  await stream.body!.getReader().read();
  client.abort();

  // workerd stops pulling once it sees the request cancelled. The cancel can
  // take a while to land on a loaded machine, so wait for the count to hold
  // still: a live stream pulls every 50ms and never would.
  let previous = await pulls();
  await expect
    .poll(
      async () => {
        await sleep(300);
        const next = await pulls();
        const stopped = next === previous;
        previous = next;
        return stopped;
      },
      { timeout: 15_000, interval: 0 },
    )
    .toBe(true);
});

test("keeps connections usable after the Worker answers without reading the body", async () => {
  // A body size cap, checked before the body is read.
  const url = await devServer(`
    export default {
      fetch(request) {
        if (Number(request.headers.get("content-length")) > 1024 * 1024) {
          return new Response("too large", { status: 413 });
        }
        return new Response("ok");
      },
    };
  `);
  const keptAlive = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
  onTestFinished(() => keptAlive.destroy());

  // Each round trip has a few-percent chance of passing without the fix, so
  // the test makes several.
  for (let i = 0; i < 3; i++) {
    const tooLarge = await send(new URL("/upload", url), {
      agent: keptAlive,
      method: "POST",
      body: Buffer.alloc(1024 * 1024 + 1, "a"),
    });
    expect(tooLarge).toEqual({ status: 413, body: "too large" });
    // The client's connection, which carried the upload, is still usable.
    expect(await send(new URL("/", url), { agent: keptAlive })).toEqual({
      status: 200,
      body: "ok",
    });
  }
});

test("streams the Worker's response while the request body is still arriving", async () => {
  // Echoes the request body: the response starts before the body has been
  // read.
  const url = await devServer(`
    export default {
      fetch(request) {
        return new Response(request.body);
      },
    };
  `);
  const body = Buffer.alloc(4 * 1024 * 1024, "a");

  const echo = await send(new URL("/echo", url), { agent: false, method: "POST", body });
  expect(echo.status).toBe(200);
  expect(echo.body.length).toBe(body.length);
});

test("forwards each request on a connection of its own", async () => {
  // Pins the defensive connection per request (see worker-request.ts). The
  // reuse failure it guards against hasn't been reproduced with workerd, so a
  // stand-in plays workerd having closed a connection the proxy still holds:
  // a second request on any connection finds it gone.
  const served = new WeakSet<Socket>();
  const runtime = await listen(
    NodeHttp.createServer((request, response) => {
      if (served.has(request.socket)) {
        request.socket.destroy();
        return;
      }
      served.add(request.socket);
      response.end("worker");
    }),
  );
  const proxy = await proxyTo(runtime);

  // `fetch` keeps the client's connection alive, so the proxy alone decides
  // whether its upstream connection is reused.
  const get = async () => {
    const response = await fetch(proxy, { signal: AbortSignal.timeout(5_000) });
    return { status: response.status, body: await response.text() };
  };
  expect(await get()).toEqual({ status: 200, body: "worker" });
  expect(await get()).toEqual({ status: 200, body: "worker" });
});

test("never forwards to a host named in the request path", async () => {
  // Another service on the machine that a `//host/` path must not reach (#2344).
  const other = await listen(NodeHttp.createServer((_request, response) => response.end("other")));
  const url = new NodeURL(
    await devServer(`
      export default {
        fetch(request) {
          const { pathname, search } = new URL(request.url);
          return new Response("worker " + pathname + search);
        },
      };
    `),
  );
  // `node:http` sends `path` verbatim, the way `curl --path-as-is` does.
  const get = (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      NodeHttp.get({ host: url.hostname, port: url.port, path, agent: false }, (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString()));
      }).on("error", reject);
    });
  expect(await get(`//${other.host}/marker.txt?x=1`)).toBe(`worker //${other.host}/marker.txt?x=1`);
  expect(await get(`${other.origin}/marker.txt`)).toBe("worker /marker.txt");
});

test("relays the Worker's status text and repeated Set-Cookie request headers", async () => {
  const url = new NodeURL(
    await devServer(`
      export default {
        fetch(request) {
          return Response.json(request.headers.getSetCookie(), {
            status: 231,
            statusText: "global-before",
          });
        },
      };
    `),
  );
  // Each cookie carries a comma in `Expires`, so joining them would merge
  // their boundaries.
  const cookies = [
    "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
    "b=2; Expires=Thu, 22 Oct 2026 07:28:00 GMT",
  ];
  const response = await new Promise<NodeHttp.IncomingMessage & { body: string }>(
    (resolve, reject) => {
      NodeHttp.get(
        {
          host: url.hostname,
          port: url.port,
          path: "/",
          agent: false,
          headers: { "set-cookie": cookies },
        },
        (response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve(Object.assign(response, { body: Buffer.concat(chunks).toString() })),
          );
        },
      ).on("error", reject);
    },
  );
  expect(response.statusCode).toBe(231);
  expect(response.statusMessage).toBe("global-before");
  expect(JSON.parse(response.body)).toEqual(cookies);
});
