import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runBuildChild } from "../../core/BuildChild.ts";
import { buildCloudflare, clientPlugins } from "../CloudflareBuild.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)),
  );

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageDir = yield* path.fromFileUrl(
    new URL("../../../", import.meta.url),
  );
  const source = yield* path.fromFileUrl(
    new URL("./fixtures/cloudflare", import.meta.url),
  );
  const root = yield* fs.makeTempDirectoryScoped({
    directory: packageDir,
    prefix: ".octane-test-",
  });
  yield* fs.copy(source, root, { overwrite: true });
  return root;
});

const build = (root: string) =>
  runBuildChild({
    module: new URL("../source.ts", import.meta.url).href,
    rootDir: root,
    framework: "octane",
    config: {
      rootDir: root,
      compatibilityDate: "2026-08-31",
      compatibilityFlags: [],
    },
  });

describe("Octane Cloudflare build", () => {
  it("preserves native plugins without mutating their server hooks", async () => {
    const closeBundle = () => undefined;
    const native = { name: "@octanejs/vite-plugin", closeBundle };
    const custom = { name: "custom" };
    const plugins = await run(
      clientPlugins([Promise.resolve([native, false]), custom]),
    );
    expect(plugins.map((plugin) => plugin.name)).toEqual([
      native.name,
      custom.name,
    ]);
    expect(plugins[0]?.closeBundle).toBeUndefined();
    expect(native.closeBundle).toBe(closeBundle);
    expect(plugins[1]).toBe(custom);
  });

  it("rejects a missing native plugin instead of silently dropping SSR", async () => {
    const error = await run(
      clientPlugins([{ name: "unrelated" }]).pipe(Effect.flip),
    );
    expect(error.message).toContain("native octane()");
  });

  it("builds and serves an adapter-free app with native plugins, CSS, routes, and bindings", async () => {
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fixture;
        const configPath = path.join(root, "octane.config.ts");
        const vitePath = path.join(root, "vite.config.ts");
        const config = yield* fs.readFileString(configPath);
        const vite = yield* fs.readFileString(vitePath);
        const output = yield* build(`${root}/`);
        expect(output.serverModules?.[0]?.name).toBe("server/worker.js");
        expect(output.clientDirectory).toBe(path.join(root, "output/client"));
        expect(
          yield* fs.exists(path.join(root, "output/client/index.html")),
        ).toBe(false);
        expect(yield* fs.exists(path.join(root, "output/client/.vite"))).toBe(
          false,
        );
        expect(yield* fs.readFileString(configPath)).toBe(config);
        expect(yield* fs.readFileString(vitePath)).toBe(vite);
        expect(
          (yield* fs.readDirectory(root)).filter((entry) =>
            entry.startsWith(".alchemy-octane-worker-"),
          ),
        ).toEqual([]);
        const modules = output.serverModules
          ?.map((module) => Buffer.from(module.content).toString())
          .join("\n");
        expect(modules).not.toContain("node:fs");
        expect(modules).not.toContain("node:http");
        const worker = yield* Effect.tryPromise(
          () =>
            import(
              /* @vite-ignore */ pathToFileURL(
                path.join(root, "output/server/worker.js"),
              ).href
            ),
        );
        const fetch = (pathname: string, init?: RequestInit) =>
          Effect.tryPromise(
            () =>
              worker.default.fetch(
                new Request(`https://octane.example${pathname}`, init),
                { MESSAGE: "hello" },
                { waitUntil() {} },
              ) as Promise<Response>,
          );
        const response = yield* fetch("/api/hello");
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({
          message: "native-config:hello",
          hasWaitUntil: true,
        });
        for (const route of ["/", "/other"]) {
          const page = yield* fetch(route);
          expect(page.status).toBe(200);
          const html = yield* Effect.tryPromise(() => page.text());
          expect(html).toContain("ALCHEMY_OCTANE_WORKER");
          expect(html).toContain("native-plugin-preserved");
          expect(html).toMatch(/stylesheet[^>]+\.css/);
        }
        const rpcId = yield* Effect.sync(() =>
          createHash("sha256")
            .update("/src/rpc.tsx#greet")
            .digest("hex")
            .slice(0, 8),
        );
        const rpc = yield* fetch(`/_$_ripple_rpc_$_/${rpcId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://octane.example",
          },
          body: '[[1],"Worker"]',
        });
        expect(rpc.status).toBe(200);
        expect(yield* Effect.tryPromise(() => rpc.text())).toContain(
          '"hello Worker"',
        );
        expect((yield* fetch("/missing")).status).toBe(404);
      }),
    );
  }, 120_000);

  it("preserves Cloudflare module imports in the Worker bundle", async () => {
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fixture;
        const file = path.join(root, "octane.config.ts");
        const config = yield* fs.readFileString(file);
        yield* fs.writeFileString(
          file,
          config
            .replace(
              "handler: (context) => {",
              'handler: async (context) => { const { env } = await import("cloudflare:workers");',
            )
            .replace(
              "message: `${prefix}:${platform.env.MESSAGE}`",
              "message: `${prefix}:${env.MESSAGE}`",
            ),
        );
        const output = yield* build(root);
        expect(
          output.serverModules
            ?.map((module) => Buffer.from(module.content).toString())
            .join("\n"),
        ).toContain("cloudflare:workers");
      }),
    );
  }, 120_000);

  it("cleans generated files after a server-build failure without rewriting config", async () => {
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fixture;
        const file = path.join(root, "vite.config.ts");
        const original = yield* fs.readFileString(file);
        const failing = original.replace(
          'name: "native-app-plugin",',
          'name: "native-app-plugin", configResolved(config) { if (config.build.ssr) throw new Error("intentional server-build failure"); },',
        );
        yield* fs.writeFileString(file, failing);
        yield* build(root).pipe(Effect.flip);
        expect(yield* fs.readFileString(file)).toBe(failing);
        expect(
          yield* fs.exists(path.join(root, "output/client/index.html")),
        ).toBe(true);
        expect(
          (yield* fs.readDirectory(root)).filter((entry) =>
            entry.startsWith(".alchemy-octane-worker-"),
          ),
        ).toEqual([]);
      }),
    );
  }, 120_000);

  it("rejects incompatible adapter declarations", async () => {
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fixture;
        const configPath = path.join(root, "octane.config.ts");
        const config = yield* fs.readFileString(configPath);
        yield* fs.writeFileString(
          configPath,
          config.replace(
            "defineConfig({",
            'defineConfig({ adapter: { name: "vercel" },',
          ),
        );
        const error = yield* buildCloudflare(root).pipe(Effect.flip);
        expect(error.message).toContain(
          '"vercel" is incompatible with Cloudflare',
        );
      }),
    );
  }, 30_000);
});
