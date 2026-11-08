import * as fs from "node:fs/promises";
import * as path from "node:path";
import { dev } from "astro";
import type { HMRPayload } from "vite";
import { expect, it, vi } from "vitest";
import { distilledCloudflare } from "../integration.ts";

it("evaluates the Worker entry and image page without replacing cold SSR dependencies", async () => {
  // A fresh root gives every run an empty optimizer cache while keeping the
  // package's dependencies reachable through its parent node_modules.
  const tempRoot = path.resolve(import.meta.dirname, "../../.cache/astro-cold-start");
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, "app-"));
  const reloads: Array<unknown> = [];
  let server: Awaited<ReturnType<typeof dev>> | undefined;
  try {
    await fs.mkdir(path.join(root, "src/pages"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules/@alchemy.run"), { recursive: true });
    await fs.symlink(
      path.resolve(import.meta.dirname, "../../.."),
      path.join(root, "node_modules/@alchemy.run/frontend-frameworks"),
      "junction",
    );
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await fs.writeFile(
      path.join(root, "src/pages/index.astro"),
      `---
import { Image } from "astro:assets";
---
<h1>Hello</h1>
<Image src="https://example.com/a.png" alt="" width={1} height={1} />
`,
    );
    server = await dev({
      root,
      configFile: false,
      logLevel: "warn",
      server: { port: 0, host: "127.0.0.1" },
      integrations: [
        distilledCloudflare({
          vite: {
            compatibilityDate: "2026-03-10",
            compatibilityFlags: ["nodejs_compat"],
            worker: { name: "astro-cold-start-test", bindings: [] },
          },
        }),
      ],
      vite: {
        plugins: [
          {
            name: "test:capture-ssr-reloads",
            enforce: "pre",
            configureServer(viteServer) {
              const hot = viteServer.environments.ssr.hot;
              const send = hot.send.bind(hot);
              vi.spyOn(hot, "send").mockImplementation(
                (payload: HMRPayload | string, data?: unknown) => {
                  if (typeof payload === "string") return send(payload, data);
                  if (payload.type === "full-reload") {
                    reloads.push(payload);
                  }
                  return send(payload);
                },
              );
            },
          },
        ],
      },
    });
    for (let request = 0; request < 2; request++) {
      const response = await fetch(`http://127.0.0.1:${server.address.port}/`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      // Astro's dev server annotates elements with `data-astro-source-*`.
      expect(html).toMatch(/<h1[^>]*>Hello<\/h1>/);
      expect(html).toContain("<img");
    }
    // A 200 alone is insufficient: entry export detection can fail while
    // Astro later recovers enough to serve the page (alchemy#1981).
    expect(reloads).toEqual([]);
  } finally {
    await server?.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
