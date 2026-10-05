import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { resolveVinextCli } from "../cli.ts";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import {
  SERVER_ENTRY_NAME,
  VINEXT_NODE_INSTALL,
  makeNodeTarget,
  makeVinextServeEntrySource,
  target,
} from "../node.ts";

describe("makeNodeTarget", () => {
  it.each([
    { hybrid: false, inline: false },
    { hybrid: true, inline: false },
    { hybrid: false, inline: true },
  ])(
    "builds and serves without an Alchemy plugin (hybrid: $hybrid, inline config: $inline)",
    ({ hybrid, inline }) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const example = yield* path.fromFileUrl(
              new URL(
                "../../../../../examples/prisma-website-vinext/",
                import.meta.url,
              ),
            );
            const root = yield* fs.makeTempDirectoryScoped({
              prefix: "vinext-node-",
            });
            yield* fs.symlink(
              path.join(example, "node_modules"),
              path.join(root, "node_modules"),
            );
            yield* fs.writeFileString(
              path.join(root, "package.json"),
              '{"type":"module"}',
            );
            if (inline) {
              yield* fs.writeFileString(
                path.join(root, "vite.config.ts"),
                `
                import vinext from "vinext";
                export default { plugins: [vinext({ prerender: true, nextConfig: {
                  basePath: "/nested", pageExtensions: ["page.tsx"],
                } })] };
              `,
              );
            }
            yield* fs.makeDirectory(path.join(root, "pages"));
            yield* fs.writeFileString(
              path.join(
                root,
                inline ? "pages/legacy.page.tsx" : "pages/legacy.tsx",
              ),
              "export default function Page() { return <h1>Legacy page</h1>; }",
            );
            if (hybrid) {
              yield* fs.makeDirectory(path.join(root, "app"));
              yield* fs.writeFileString(
                path.join(root, "app/layout.tsx"),
                "export default function Layout({children}) { return <html><body>{children}</body></html>; }",
              );
              yield* fs.writeFileString(
                path.join(root, "app/page.tsx"),
                "export default function Page() { return <h1>App page</h1>; }",
              );
            }
            yield* fs.makeDirectory(path.join(root, "dist"));
            yield* fs.writeFileString(
              path.join(root, "dist/stale.txt"),
              "old build",
            );
            const built = yield* makeNodeTarget().build!({
              root,
              framework: "vinext",
            });
            expect(yield* fs.exists(path.join(root, "vite.config.ts"))).toBe(
              inline,
            );
            if (inline) {
              expect(
                yield* fs.readFileString(
                  path.join(root, "dist/server/vinext-prerender.json"),
                ),
              ).toContain('"route": "/legacy"');
            }
            expect(
              yield* fs.readFileString(
                path.join(built.distDirectory!, "server/entry.js"),
              ),
            ).toContain("REDIS_URL");
            expect(yield* fs.exists(path.join(root, "dist/stale.txt"))).toBe(
              false,
            );
            if (hybrid) {
              const buildId = (yield* fs.readFileString(
                path.join(root, "dist/server/BUILD_ID"),
              )).trim();
              const manifest = JSON.parse(
                yield* fs.readFileString(
                  path.join(root, "dist/server/vinext-server.json"),
                ),
              );
              for (const entry of ["index.js", "entry.js"]) {
                const code = yield* fs.readFileString(
                  path.join(root, "dist/server", entry),
                );
                expect(code).toContain(buildId);
                expect(code).toContain(manifest.prerenderSecret);
              }
              const assets = yield* fs.readFileString(
                path.join(root, "dist/server/ssr/vinext-client-assets.js"),
              );
              expect(assets).not.toContain('"clientEntry":null');
            }
            const spawner = yield* ChildProcessSpawner;
            const child = yield* spawner.spawn(
              ChildProcess.make(
                "node",
                [
                  "--input-type=module",
                  "--eval",
                  `
        import assert from "node:assert/strict";
        import { startProdServer } from "vinext/server/prod-server";
        const { server } = await startProdServer({ port: 0, host: "127.0.0.1", outDir: ${JSON.stringify(built.distDirectory)} });
        try {
          const base = "http://127.0.0.1:" + server.address().port;
          for (const [route, text] of ${JSON.stringify(
            hybrid
              ? [
                  ["/legacy", "Legacy page"],
                  ["/", "App page"],
                ]
              : [[inline ? "/nested/legacy" : "/legacy", "Legacy page"]],
          )}) {
            const response = await fetch(base + route);
            assert.equal(response.status, 200);
            assert.ok((await response.text()).includes(text));
          }
        } finally { await new Promise((resolve) => server.close(resolve)); }
      `,
                ],
                { cwd: root, stdout: "inherit", stderr: "inherit" },
              ),
            );
            expect(yield* child.exitCode).toBe(0);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      ),
    120_000,
  );
  it("resolves the installed CLI without requiring an exported CLI subpath", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* path.fromFileUrl(
          new URL(
            "../../../../../examples/prisma-website-vinext/",
            import.meta.url,
          ),
        );
        const cli = yield* resolveVinextCli(root);
        expect(cli).toMatch(/vinext\/dist\/cli\.js$/);
        expect(yield* fs.exists(cli)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));
  it("declares the node platform and a wholesale vinext build (not Cloudflare)", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.build).toBeTypeOf("function");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
  });

  it("writes a startProdServer serve entry with /health, not a Worker fetch handler", () => {
    const source = makeVinextServeEntrySource();
    expect(SERVER_ENTRY_NAME).toBe("server/serve-node.mjs");
    expect(source).toContain('from "vinext/server/prod-server"');
    expect(source).toContain("startProdServer");
    expect(source).toContain("/health");
    expect(source).toContain("process.env.PORT");
    expect(source).not.toContain("vinext/server/fetch-handler");
    expect(source).not.toContain("aws-lambda");
    expect(source).not.toContain("cloudflare");
    expect(source).not.toContain("worker/index.ts");
  });

  it("installs vinext and React at runtime instead of bundling them", () => {
    expect(VINEXT_NODE_INSTALL).toContain("vinext");
    expect(VINEXT_NODE_INSTALL).toContain("react");
    expect(VINEXT_NODE_INSTALL).toContain("react-dom");
    expect(VINEXT_NODE_INSTALL).toContain("react-server-dom-webpack");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
