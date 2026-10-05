import cloudflareVitePlugin from "../plugin.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vite from "vite";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * A Worker whose default entrypoint reaches the Worker's own exports, so a test
 * can prove that a named entrypoint really was exported by the generated Worker
 * rather than just detected by the dev server.
 */
const worker = (entrypoints: Array<string>) => `
import { WorkerEntrypoint } from "cloudflare:workers";

${entrypoints
  .map(
    (name) => `export class ${name} extends WorkerEntrypoint {
  greet(who) {
    return "${name}:" + who;
  }
}`,
  )
  .join("\n\n")}

export default {
  async fetch(request, env, ctx) {
    const name = new URL(request.url).searchParams.get("entrypoint");
    if (!name) {
      return new Response("ok");
    }
    const entrypoint = ctx.exports[name];
    if (!entrypoint) {
      return new Response("missing:" + name, { status: 404 });
    }
    return new Response(await entrypoint.greet("world"));
  },
};
`;

/** Under `.cache` so a crashed run cannot leave untracked files behind. */
const TMP_ROOT = path.resolve(import.meta.dirname, "../.cache/test-roots");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startDevServer(source: string) {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  const root = await fs.mkdtemp(path.join(TMP_ROOT, "export-types-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

  const entry = path.join(root, "worker.js");
  const write = (next: string) => fs.writeFile(entry, next);
  await write(source);

  const server = await vite.createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { port: 0 },
    plugins: [
      cloudflareVitePlugin({
        main: entry,
        // `ctx.exports` is on by default from 2025-11-17.
        compatibilityDate: "2026-03-10",
        worker: { name: "vite-plugin-export-types-test", bindings: [] },
      }),
    ],
  });
  cleanups.push(() => server.close());
  await server.listen();

  const url = server.resolvedUrls?.local[0];
  if (!url) {
    throw new Error("Dev server did not report a local URL");
  }

  // A request that lands while the Worker runtime is being replaced can fail
  // outright, so callers get a status they can retry on rather than a throw.
  const greet = async (name: string) => {
    try {
      const response = await fetch(new URL(`/?entrypoint=${name}`, url), {
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { status: 0, body: String(error) };
    }
  };

  return { greet, write, server };
}

/** Polls until the dev server has restarted the Worker for the new exports. */
async function greetEventually(
  greet: (name: string) => Promise<{ status: number; body: string }>,
  name: string,
) {
  const deadline = Date.now() + 30_000;
  let last = await greet(name);
  while (last.status !== 200 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await greet(name);
  }
  return last;
}

describe("Worker export detection", () => {
  test("recreates Vite environments after a crash and still applies HMR", async () => {
    vi.stubEnv("ALCHEMY_WORKERD_V8_FLAGS", "--max-old-space-size=64");
    cleanups.push(async () => {
      vi.unstubAllEnvs();
    });
    const source = (message: string) => `
      const hog = [];
      export default {
        fetch(request) {
          if (new URL(request.url).searchParams.get("entrypoint") === "crash") {
            for (;;) hog.push(new Array(1_000_000).fill("crash"));
          }
          return new Response("${message}");
        }
      };
    `;
    const { greet, write, server } = await startDevServer(source("before"));
    expect(await greet("")).toEqual({ status: 200, body: "before" });

    for (let crash = 0; crash < 2; crash++) {
      const previousEnvironment = server.environments.ssr;
      expect((await greet("crash")).status).not.toBe(200);
      await expect
        .poll(() => server.environments.ssr, { timeout: 10_000, interval: 250 })
        .not.toBe(previousEnvironment);
      await expect
        .poll(() => greet(""), { timeout: 10_000, interval: 250 })
        .toEqual({ status: 200, body: "before" });
    }

    await write(source("after"));
    await expect
      .poll(() => greet(""), { timeout: 10_000, interval: 250 })
      .toEqual({ status: 200, body: "after" });
  }, 60_000);

  test("exports named entrypoints that are not declared in the plugin options", async () => {
    const { greet } = await startDevServer(worker(["NamedEntrypoint"]));

    expect(await greet("NamedEntrypoint")).toEqual({
      status: 200,
      body: "NamedEntrypoint:world",
    });
  });

  test("does not export entrypoints the Worker entry never defined", async () => {
    const { greet } = await startDevServer(worker(["NamedEntrypoint"]));

    expect(await greet("Missing")).toEqual({
      status: 404,
      body: "missing:Missing",
    });
  });

  test("starts without waiting out the detection timeout when the entry throws", async () => {
    const startedAt = Date.now();
    const { greet } = await startDevServer('throw new Error("boom");');

    // Detection gives the Worker 10s to reply; a Worker that cannot evaluate
    // the entry has to reply with a failure rather than go quiet.
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect((await greet("NamedEntrypoint")).status).toBe(500);
  });

  test("picks up an entrypoint added while the dev server is running", async () => {
    const { greet, write } = await startDevServer(worker(["NamedEntrypoint"]));
    expect((await greet("AddedEntrypoint")).status).toBe(404);

    await write(worker(["NamedEntrypoint", "AddedEntrypoint"]));

    expect(await greetEventually(greet, "AddedEntrypoint")).toEqual({
      status: 200,
      body: "AddedEntrypoint:world",
    });
    expect(await greet("NamedEntrypoint")).toEqual({
      status: 200,
      body: "NamedEntrypoint:world",
    });
  });
});
