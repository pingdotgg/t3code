import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as vite from "vite";
import { expect, onTestFinished, test, vi } from "vitest";
import * as Assets from "../../core/bindings/assets/Assets.ts";
import cloudflareVitePlugin from "../plugin.ts";

test.each([
  ["selective Worker routes", ["/api/*"]],
  ["explicitly excluded internal routes", ["/api/*", "!/cdn-cgi/alchemy/module-runner/*"]],
  ["assets first", false],
  ["Worker first", true],
] as const)("starts the module runner with SPA fallback and %s", async (_, runWorkerFirst) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  // These tests use only the local runtime; no Cloudflare API calls are needed.
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "worker.js");
  await fs.writeFile(path.join(root, "index.html"), "<html><body>SPA shell</body></html>");
  await fs.writeFile(
    entry,
    `
    export default {
      fetch(request, env) {
        if (new URL(request.url).pathname.startsWith("/api/")) {
          return new Response("api");
        }
        return env.ASSETS.fetch(request);
      },
    };
  `,
  );
  const server = await vite.createServer({
    root,
    configFile: false,
    cacheDir: path.join(root, ".vite"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      cloudflareVitePlugin({
        main: entry,
        worker: {
          name: "vite-dev-assets-test",
          bindings: [Assets.local("ASSETS")],
          assets: {
            runWorkerFirst:
              typeof runWorkerFirst === "boolean" ? runWorkerFirst : [...runWorkerFirst],
            notFoundHandling: "single-page-application",
          },
        },
      }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  const url = server.resolvedUrls!.local[0];
  const page = await fetch(new URL("/dashboard", url), {
    signal: AbortSignal.timeout(5_000),
  });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("SPA shell");
  if (runWorkerFirst !== false) {
    const api = await fetch(new URL("/api/hello", url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(api.status).toBe(200);
    expect(await api.text()).toBe("api");
  }
});

test("a Worker reads HTML and binary files in Vite's publicDir through ASSETS", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-public-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  await fs.mkdir(path.join(root, "public"));
  await fs.writeFile(
    path.join(root, "public", "about.html"),
    "<html><body>public page</body></html>",
  );
  await fs.writeFile(path.join(root, "public", "og.png"), png);
  const entry = path.join(root, "worker.js");
  await fs.writeFile(
    entry,
    `
    export default {
      fetch(request, env) {
        const { pathname } = new URL(request.url);
        return env.ASSETS.fetch(new URL(pathname.slice("/read".length), request.url));
      },
    };
  `,
  );
  const server = await vite.createServer({
    root,
    configFile: false,
    cacheDir: path.join(root, ".vite"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      cloudflareVitePlugin({
        main: entry,
        worker: {
          name: "vite-dev-assets-public-test",
          bindings: [Assets.local("ASSETS")],
          assets: { runWorkerFirst: ["/read/*"] },
        },
      }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  const url = server.resolvedUrls!.local[0];

  const page = await fetch(new URL("/read/about", url), { signal: AbortSignal.timeout(5_000) });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toBe("<html><body>public page</body></html>");

  const image = await fetch(new URL("/read/og.png", url), { signal: AbortSignal.timeout(5_000) });
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
});

// https://github.com/alchemy-run/alchemy/issues/2250
test("a Worker reads every byte of a publicDir file through ASSETS with SPA fallback", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-binary-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await fs.writeFile(path.join(root, "index.html"), "<html><body>SPA shell</body></html>");
  await fs.mkdir(path.join(root, "public"));
  await fs.writeFile(path.join(root, "public", "sample.bin"), bytes);
  const entry = path.join(root, "worker.js");
  await fs.writeFile(
    entry,
    `
    export default {
      fetch(request, env) {
        return env.ASSETS.fetch(new Request(new URL("/sample.bin", request.url), request));
      },
    };
  `,
  );
  const server = await vite.createServer({
    root,
    configFile: false,
    cacheDir: path.join(root, ".vite"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      cloudflareVitePlugin({
        main: entry,
        worker: {
          name: "vite-dev-assets-binary-test",
          bindings: [Assets.local("ASSETS")],
          assets: { runWorkerFirst: true, notFoundHandling: "single-page-application" },
        },
      }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  const url = server.resolvedUrls!.local[0];

  const response = await fetch(new URL("/dashboard", url), { signal: AbortSignal.timeout(5_000) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

// Vite resolves a disabled `publicDir` to `""`, which must not turn a
// requested pathname into an absolute path on the host's filesystem.
test("a Worker cannot read files outside the root through ASSETS when publicDir is disabled", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-no-public-"));
  const outside = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-outside-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  onTestFinished(() => fs.rm(outside, { recursive: true, force: true }));
  const secret = path.join(outside, "secret.bin");
  await fs.writeFile(secret, "outside the root");
  const entry = path.join(root, "worker.js");
  await fs.writeFile(
    entry,
    `
    export default {
      fetch(request, env) {
        const { pathname } = new URL(request.url);
        return env.ASSETS.fetch(new URL(pathname.slice("/read".length), request.url));
      },
    };
  `,
  );
  const server = await vite.createServer({
    root,
    configFile: false,
    cacheDir: path.join(root, ".vite"),
    publicDir: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      cloudflareVitePlugin({
        main: entry,
        worker: {
          name: "vite-dev-assets-no-public-test",
          bindings: [Assets.local("ASSETS")],
          assets: { runWorkerFirst: ["/read/*"] },
        },
      }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  const url = server.resolvedUrls!.local[0];

  const response = await fetch(new URL(`/read${pathToFileURL(secret).pathname}`, url), {
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("outside the root");
});

// `@cloudflare/vite-plugin` serves HTML through `transformIndexHtml` (`public/`
// HTML as is) and applies `server.headers` to asset responses.
test("serves HTML through Vite with the dev server's headers", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-html-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "index.html"), "<html><head></head><body>shell</body></html>");
  await fs.mkdir(path.join(root, "public"));
  await fs.writeFile(
    path.join(root, "public", "raw.html"),
    "<html><head></head><body>raw</body></html>",
  );
  const entry = path.join(root, "worker.js");
  await fs.writeFile(
    entry,
    `export default { fetch: (request, env) => env.ASSETS.fetch(request) };`,
  );
  const server = await vite.createServer({
    root,
    configFile: false,
    cacheDir: path.join(root, ".vite"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, headers: { "x-dev-header": "from-vite" } },
    plugins: [
      cloudflareVitePlugin({
        main: entry,
        worker: { name: "vite-dev-assets-html-test", bindings: [Assets.local("ASSETS")] },
      }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  const url = server.resolvedUrls!.local[0];

  const index = await fetch(new URL("/", url), { signal: AbortSignal.timeout(5_000) });
  expect(index.status).toBe(200);
  expect(index.headers.get("x-dev-header")).toBe("from-vite");
  expect(await index.text()).toContain("/@vite/client");

  const raw = await fetch(new URL("/raw.html", url), { signal: AbortSignal.timeout(5_000) });
  expect(raw.status).toBe(200);
  expect(raw.headers.get("x-dev-header")).toBe("from-vite");
  expect(await raw.text()).not.toContain("/@vite/client");
});

// Additional modules load as Worker modules, not through the module runner,
// so editing one restarts the dev server, as `@cloudflare/vite-plugin` does.
test("restarts the dev server when an additional module changes", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-module-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "message.txt"), "one");
  const entry = path.join(root, "worker.js");
  await fs.writeFile(
    entry,
    `import message from "./message.txt";\nexport default { fetch: () => new Response(message) };`,
  );
  const server = await vite.createServer({
    root,
    configFile: false,
    cacheDir: path.join(root, ".vite"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      cloudflareVitePlugin({ main: entry, worker: { name: "vite-dev-module-test", bindings: [] } }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  const url = server.resolvedUrls!.local[0];
  const first = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  expect(await first.text()).toBe("one");
  const restart = vi.spyOn(server, "restart").mockResolvedValue();
  await fs.writeFile(path.join(root, "message.txt"), "two");
  await vi.waitFor(() => expect(restart).toHaveBeenCalled(), { timeout: 10_000 });
});
