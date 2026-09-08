import * as NodeHttp from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import * as vite from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { DistilledDevEnvironment } from "../dev-environment.ts";
import cloudflareVitePlugin from "../plugin.ts";

// Stand-in for the workerd dev runtime: a plain HTTP server (every proxied
// request responds with "worker") that also accepts the module-runner
// WebSocket connections `DistilledDevEnvironment.connect` opens.
let runtimeAddress: string;

vi.mock("../dev-server.ts", () => ({
  createDefaultContext: async () => ({}),
  startServer: async () => ({
    address: runtimeAddress,
    close: async () => {},
  }),
}));

const root = path.join(import.meta.dirname, "fixtures");

const listen = (server: NodeHttp.Server): Promise<string> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

describe("dev plugin", () => {
  let runtimeServer: NodeHttp.Server;
  let webSocketServer: WebSocketServer;

  beforeAll(async () => {
    runtimeServer = NodeHttp.createServer((_req, res) => {
      res.end("worker");
    });
    webSocketServer = new WebSocketServer({ server: runtimeServer });
    runtimeAddress = await listen(runtimeServer);
  });

  afterAll(async () => {
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    webSocketServer.close();
    runtimeServer.closeAllConnections();
    await new Promise((resolve) => runtimeServer.close(resolve));
  });

  const createDevServer = (plugins: vite.PluginOption) =>
    vite.createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [plugins],
      server: { middlewareMode: true, hmr: false },
    });

  const request = async (
    server: vite.ViteDevServer,
    url: string,
  ): Promise<{ status: number; text: string }> => {
    const httpServer = NodeHttp.createServer(server.middlewares);
    const address = await listen(httpServer);
    try {
      const response = await fetch(`${address}${url}`);
      return { status: response.status, text: await response.text() };
    } finally {
      httpServer.closeAllConnections();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };

  const frameworkPlugin = (): vite.Plugin => ({
    name: "fake-framework",
    configureServer(server) {
      return () => {
        // Mimics a framework's Node request bridge (e.g. Waku's RSC bridge):
        // a catch-all post middleware registered by a plugin that precedes
        // ours in the plugin order.
        server.middlewares.use(function frameworkCatchAll(_req, res) {
          res.statusCode = 200;
          res.end("framework");
        });
      };
    },
  });

  it("degrades to a runnable environment when configureServer is stripped (framework typegen servers)", async () => {
    // Frameworks strip `configureServer` off the plugin instances when they
    // create throwaway dev servers (e.g. Astro's type generation during
    // `build`/`sync`) so no workerd runtime boots mid-build.
    const plugins = cloudflareVitePlugin({
      main: "./worker-entry.ts",
    }) as Array<vite.Plugin>;
    for (const plugin of plugins) {
      plugin.configureServer = undefined;
    }
    const server = await createDevServer(plugins);
    try {
      const environment = server.environments["ssr"];
      expect(environment).toBeDefined();
      expect(environment).not.toBeInstanceOf(DistilledDevEnvironment);
      expect(vite.isRunnableDevEnvironment(environment!)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("creates the Distilled environment when configureServer is intact", async () => {
    const server = await createDevServer(
      cloudflareVitePlugin({ main: "./worker-entry.ts" }),
    );
    try {
      expect(server.environments["ssr"]).toBeInstanceOf(
        DistilledDevEnvironment,
      );
    } finally {
      await server.close();
    }
  });

  it("registers the proxy middleware after other plugins' post middlewares by default", async () => {
    const server = await createDevServer([
      frameworkPlugin(),
      cloudflareVitePlugin({ main: "./worker-entry.ts" }),
    ]);
    try {
      const response = await request(server, "/");
      expect(response.text).toBe("framework");
    } finally {
      await server.close();
    }
  });

  it('registers the proxy middleware ahead of other plugins\' post middlewares with middlewareOrder: "pre"', async () => {
    const server = await createDevServer([
      frameworkPlugin(),
      cloudflareVitePlugin({
        main: "./worker-entry.ts",
        dev: { middlewareOrder: "pre" },
      }),
    ]);
    try {
      // Appended after the framework's plugins, the proxy still sees requests
      // first, so the framework's Node bridge never fires.
      const response = await request(server, "/");
      expect(response.text).toBe("worker");
      // ...but it must not shadow Vite's own internal middlewares.
      const viteClient = await request(server, "/@vite/client");
      expect(viteClient.status).toBe(200);
      expect(viteClient.text).not.toBe("worker");
      expect(viteClient.text).not.toBe("framework");
    } finally {
      await server.close();
    }
  });
});
