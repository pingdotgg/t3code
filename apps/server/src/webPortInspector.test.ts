import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { defaultWebPortInspector } from "./webPortInspector";

async function listenServer(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("Server did not provide a valid listening address.");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("defaultWebPortInspector", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0, servers.length).map((server) => closeServer(server)));
  });

  it("treats slow HTML responses as web ports", async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<!DOCTYPE html><html><head><title>ok</title></head><body>hello</body></html>");
      }, 800);
    });
    servers.push(server);
    const port = await listenServer(server);

    await expect(defaultWebPortInspector(port)).resolves.toBe(true);
  });

  it("treats HTML responses with large bodies as web ports", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!DOCTYPE html><html><head><title>x</title></head><body>${"x".repeat(20_000)}</body></html>`);
    });
    servers.push(server);
    const port = await listenServer(server);

    await expect(defaultWebPortInspector(port)).resolves.toBe(true);
  });

  it("ignores HTTP 404 responses", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    servers.push(server);
    const port = await listenServer(server);

    await expect(defaultWebPortInspector(port)).resolves.toBe(false);
  });
});
