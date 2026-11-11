import { fileURLToPath, pathToFileURL } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";
import { target as astro } from "../../astro/neon.ts";
import { target as nextjs } from "../../nextjs/neon.ts";
import { target as vite } from "../../vite/neon.ts";
import type { BuildOutput } from "../BuildOutput.ts";

const fixture = (kind: "vite" | "astro" | "nextjs", files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* Effect.sync(() =>
      fileURLToPath(new URL("../../../../../", import.meta.url)),
    );
    const base = path.join(workspace, ".alchemy", "neon-framework-tests");
    yield* fs.makeDirectory(base, { recursive: true });
    const root = yield* fs.makeTempDirectoryScoped({
      directory: base,
      prefix: `${kind}-`,
    });
    const dependencies = path.join(workspace, "examples", `aws-website-${kind}`, "node_modules");
    yield* fs.symlink(dependencies, path.join(root, "node_modules"));
    for (const [name, contents] of Object.entries({
      "package.json": '{"private":true,"type":"module"}',
      ...files,
    })) {
      const file = path.join(root, name);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, contents);
    }
    return root;
  });
const load = (output: BuildOutput) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    expect(output.serverModules?.[0]?.name).toContain("serve-neon.mjs");
    const url = yield* Effect.sync(
      () => pathToFileURL(path.join(output.distDirectory!, output.serverModules![0]!.name)).href,
    );
    return yield* Effect.tryPromise(
      () =>
        import(url) as Promise<{
          default: { fetch(request: Request): Promise<Response> };
        }>,
    );
  });
const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | import("effect/Scope").Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

describe("Neon production target feasibility", { concurrent: false }, () => {
  it(
    "builds actual Vite assets and serves a deep link",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* fixture("vite", {
            "index.html": '<h1>Neon Vite</h1><script type="module" src="/src.js"></script>',
            "src.js": 'document.body.dataset.ready="true";',
          });
          const output = yield* vite().build!({ root });
          const module = yield* load(output);
          const response = yield* Effect.tryPromise(() =>
            module.default.fetch(new Request("https://example.com/deep")),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.tryPromise(() => response.text())).toContain("Neon Vite");
        }),
      ),
    120_000,
  );
  it(
    "builds actual Astro SSR and invokes its Fetch handler",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* fixture("astro", {
            "astro.config.mjs": 'export default { output: "server" };',
            "src/pages/index.astro":
              '---\nconst name = Astro.url.searchParams.get("name") ?? "world";\n---\n<h1>Hello {name}</h1>',
            "public/style.css": "body{color:blue}",
          });
          const output = yield* astro().build!({ root });
          const module = yield* load(output);
          const response = yield* Effect.tryPromise(() =>
            module.default.fetch(new Request("https://example.com/?name=Neon")),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.tryPromise(() => response.text())).toContain("Hello Neon");
        }),
      ),
    120_000,
  );
  it(
    "builds actual Next.js pages and route handlers for Fetch",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* fixture("nextjs", {
            "app/layout.jsx":
              "export default function Layout({children}) {return <html><body>{children}</body></html>}",
            "app/page.jsx": "export default function Home() {return <h1>Neon Next</h1>}",
            "app/api/echo/route.js":
              "export async function POST(request) {return Response.json({value:await request.text(),url:request.url})}",
            "app/redirect/route.js":
              'import { NextResponse } from "next/server"; export function GET(request) {return NextResponse.redirect(new URL("/?redirected=yes", request.url))}',
            "app/external/route.js":
              'import { NextResponse } from "next/server"; export function GET() {return NextResponse.redirect("https://external.example/account", 303)}',
            "next.config.mjs": "export default {experimental:{cpus:1}};",
          });
          const output = yield* nextjs().build!({ root });
          const module = yield* load(output);
          const response = yield* Effect.tryPromise(() =>
            module.default.fetch(new Request("https://example.com/")),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.tryPromise(() => response.text())).toContain("Neon Next");
          const post = yield* Effect.tryPromise(() =>
            module.default.fetch(
              new Request("https://example.com/api/echo", {
                method: "POST",
                body: "value",
              }),
            ),
          );
          expect(post.status).toBe(200);
          expect(yield* Effect.tryPromise(() => post.json())).toEqual({
            value: "value",
            url: "https://example.com/api/echo",
          });
          yield* Effect.forEach(
            [
              "https://example.com",
              "http://example.com",
              "http://localhost:43821",
              "https://custom.example:8443",
              "http://other.example:8080",
              "http://[2001:db8::1]:8080",
            ],
            (origin) =>
              Effect.gen(function* () {
                const redirect = yield* Effect.tryPromise(() =>
                  module.default.fetch(
                    new Request(`${origin}/redirect`, {
                      headers: {
                        host: "wrong.invalid",
                        "x-forwarded-proto": "https",
                      },
                    }),
                  ),
                );
                expect(redirect.status).toBe(307);
                expect(redirect.headers.get("location")).toBe(`${origin}/?redirected=yes`);
                const external = yield* Effect.tryPromise(() =>
                  module.default.fetch(new Request(`${origin}/external`)),
                );
                expect(external.status).toBe(303);
                expect(external.headers.get("location")).toBe("https://external.example/account");
                const post = yield* Effect.tryPromise(() =>
                  module.default.fetch(
                    new Request(`${origin}/api/echo?source=origin`, {
                      method: "POST",
                      body: origin,
                    }),
                  ),
                );
                expect(post.status).toBe(200);
                expect(yield* Effect.tryPromise(() => post.json())).toEqual({
                  value: origin,
                  url: `${origin}/api/echo?source=origin`,
                });
              }),
            { concurrency: "unbounded" },
          );
        }),
      ),
    120_000,
  );
});
