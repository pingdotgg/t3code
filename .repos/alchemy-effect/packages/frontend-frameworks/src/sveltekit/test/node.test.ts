import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isDeployTarget } from "../../core/index.ts";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import { makeProject, run } from "../../core/test/helpers.ts";
import { makeNodeAdapter, makeNodeTarget, target } from "../node.ts";

describe("makeNodeTarget", () => {
  it("is a DeployTarget for the node platform with a finish pass", () => {
    const node = makeNodeTarget({
      adapter: { notFoundHandling: "single-page-application" },
    });
    expect(isDeployTarget(node)).toBe(true);
    expect(node.platform).toBe("node");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
    expect(node.build).toBeTypeOf("function");
    expect(node.finish).toBeTypeOf("function");
  });

  it("produces the in-memory kit adapter from the adapter hook", () => {
    const adapter = makeNodeAdapter();
    expect(adapter.name).toBe("@alchemy.run/frontend-frameworks/sveltekit/node");
    expect(adapter.result.current).toBeUndefined();
    expect(typeof adapter.adapt).toBe("function");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });

  it("serves SSR and static assets from a relocated dist directory", async () => {
    const root = await makeProject({
      "entry.js": 'export const handler = () => new Response("SSR home");',
      ".svelte-kit/node/robots.txt": "User-agent: *",
      ".svelte-kit/node/about.html": "Prerendered about",
      ".svelte-kit/node/docs/index.html": "Prerendered docs",
      ".svelte-kit/node/_app/immutable/app.css": "body { color: red; }",
      "dist/client/stale.txt": "Removed in this build",
    });
    const output = await run(
      makeNodeTarget().finish!(
        {
          distDirectory: path.join(root, "dist"),
          clientDirectory: path.join(root, ".svelte-kit/node"),
          serverModules: [],
          externalWorkspaces: new Set(),
        },
        { root, entry: path.join(root, "entry.js") },
      ),
    );
    expect(output.clientDirectory).toBe(path.join(root, "dist/client"));
    await expect(fs.stat(path.join(root, "dist/client/stale.txt"))).rejects.toThrow();

    const deployed = await makeProject({});
    await fs.cp(path.join(root, "dist"), deployed, { recursive: true });
    await fs.rm(root, { recursive: true, force: true });

    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const child = spawn(process.execPath, [path.join(deployed, output.serverModules![0]!.name)], {
      cwd: deployed,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    const base = `http://127.0.0.1:${port}`;
    try {
      await vi.waitFor(
        async () => {
          expect((await fetch(`${base}/health`)).status).toBe(200);
        },
        { timeout: 5_000, interval: 50 },
      );
      for (const [url, body] of [
        ["/", "SSR home"],
        ["/about", "Prerendered about"],
        ["/docs/", "Prerendered docs"],
        ["/robots.txt", "User-agent: *"],
        ["/_app/immutable/app.css", "body { color: red; }"],
      ]) {
        const response = await fetch(`${base}${url}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(body);
      }
    } finally {
      child.kill();
      await exited;
    }
  });
});
