import * as NodeFs from "node:fs/promises";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as vite from "vite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PreviewWorkerBuild } from "../preview-server.ts";
import cloudflareVitePlugin from "../plugin.ts";

// Stand-in for the workerd preview runtime: a plain HTTP server; every
// proxied request responds with "worker".
let runtimeAddress: string;
let startedBuilds: Array<PreviewWorkerBuild> = [];
let closed = 0;

vi.mock("../preview-server.ts", () => ({
  startPreviewServer: async (_options: unknown, build: PreviewWorkerBuild) => {
    startedBuilds.push(build);
    return {
      address: new URL(runtimeAddress),
      close: async () => {
        closed += 1;
      },
    };
  },
}));

const listen = (server: NodeHttp.Server): Promise<string> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

describe("preview plugin", () => {
  let runtimeServer: NodeHttp.Server;
  let root: string;

  beforeAll(async () => {
    runtimeServer = NodeHttp.createServer((_req, res) => {
      res.end("worker");
    });
    runtimeAddress = await listen(runtimeServer);
    // A fake built project: the entry environment's outDir with the entry
    // chunk, and a client outDir with a static asset.
    root = await NodeFs.mkdtemp(
      NodePath.join(NodeOs.tmpdir(), "distilled-preview-"),
    );
    await NodeFs.mkdir(NodePath.join(root, "dist", "ssr"), { recursive: true });
    await NodeFs.mkdir(NodePath.join(root, "dist", "client"), {
      recursive: true,
    });
    await NodeFs.writeFile(
      NodePath.join(root, "dist", "ssr", "worker-entry.js"),
      "export default { fetch: () => new Response('built worker') };",
    );
    await NodeFs.writeFile(
      NodePath.join(root, "dist", "client", "index.html"),
      "<html></html>",
    );
  });

  afterAll(async () => {
    runtimeServer.closeAllConnections();
    await new Promise((resolve) => runtimeServer.close(resolve));
    await NodeFs.rm(root, { recursive: true, force: true });
  });

  afterEach(() => {
    startedBuilds = [];
    closed = 0;
  });

  const createPreviewServer = (plugins: vite.PluginOption) =>
    vite.preview({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [plugins],
      preview: { port: 0, host: "127.0.0.1" },
    });

  const serverOrigin = (server: vite.PreviewServer): string => {
    const { port } = server.httpServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  it("serves the built worker through the runtime proxy", async () => {
    const server = await createPreviewServer(
      cloudflareVitePlugin({ main: "./worker-entry.ts" }),
    );
    try {
      const response = await fetch(`${serverOrigin(server)}/anything`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("worker");
    } finally {
      await server.close();
    }
  });

  it("resolves the built worker output from the entry environment", async () => {
    const server = await createPreviewServer(
      cloudflareVitePlugin({ main: "./worker-entry.ts" }),
    );
    try {
      expect(startedBuilds).toHaveLength(1);
      const build = startedBuilds[0]!;
      expect(build.directory).toBe(
        await NodeFs.realpath(NodePath.join(root, "dist", "ssr")),
      );
      expect(build.entryModule).toBe("worker-entry.js");
      expect(build.assetsDirectory).toBe(
        await NodeFs.realpath(NodePath.join(root, "dist", "client")),
      );
    } finally {
      await server.close();
    }
  });

  it("closes the runtime when the preview server closes", async () => {
    const server = await createPreviewServer(
      cloudflareVitePlugin({ main: "./worker-entry.ts" }),
    );
    await server.close();
    expect(closed).toBe(1);
  });

  it("stays out of the way in SPA mode (no worker entry)", async () => {
    const server = await createPreviewServer(cloudflareVitePlugin({}));
    try {
      expect(startedBuilds).toHaveLength(0);
      // Vite's own static serving handles the request.
      const response = await fetch(`${serverOrigin(server)}/index.html`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<html>");
    } finally {
      await server.close();
    }
  });

  it("fails fast when the built entry chunk is missing", async () => {
    await expect(
      createPreviewServer(cloudflareVitePlugin({ main: "./missing-entry.ts" })),
    ).rejects.toThrow(/missing-entry\.js/);
  });
});
