import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeNeonServeEntrySource } from "../../core/NeonServe.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  makeNodeServeEntrySource,
} from "../../core/NodeServe.ts";
import {
  NEXT_PRODUCTION_APP_SOURCE,
  SERVER_ENTRY_NAME,
  makeNodeTarget,
  nextNodeServeHandler,
  target,
} from "../node.ts";

describe("makeNodeTarget", () => {
  it("declares the node platform and a wholesale next build (not OpenNext)", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.build).toBeTypeOf("function");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
  });

  it("starts Next from the built config before preparing", () => {
    const source = NEXT_PRODUCTION_APP_SOURCE;
    expect(source).toContain(
      'path.join(dir, ".next", "required-server-files.json")',
    );
    expect(source.indexOf("__NEXT_PRIVATE_STANDALONE_CONFIG")).toBeLessThan(
      source.indexOf("next({ dev: false, dir })"),
    );
    expect(source.indexOf("next({ dev: false, dir })")).toBeLessThan(
      source.indexOf("await app.prepare()"),
    );
  });

  it("wires the built-config startup into the shared Node and Neon entries", () => {
    const node = makeNodeServeEntrySource({ handler: nextNodeServeHandler });
    expect(SERVER_ENTRY_NAME).toBe("serve-node.mjs");
    expect(node).toContain(NEXT_PRODUCTION_APP_SOURCE);
    expect(node).toContain('import * as fs from "node:fs"');
    expect(node).toContain("/health");
    expect(node).toContain("process.env.PORT");
    expect(node).not.toContain("opennext");
    expect(node).not.toContain("cloudflare");
    const neon = makeNeonServeEntrySource({ handler: nextNodeServeHandler });
    expect(neon).toContain(NEXT_PRODUCTION_APP_SOURCE);
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});

const fixture = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* Effect.sync(() =>
      fileURLToPath(new URL("../../../../../", import.meta.url)),
    );
    const base = path.join(workspace, ".alchemy", "nextjs-node-tests");
    yield* fs.makeDirectory(base, { recursive: true });
    const root = yield* fs.makeTempDirectoryScoped({
      directory: base,
      prefix: "nextjs-",
    });
    yield* fs.symlink(
      path.join(workspace, "examples", "aws-website-nextjs", "node_modules"),
      path.join(root, "node_modules"),
    );
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

const freePort = Effect.callback<number>((resume) => {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as NodeNet.AddressInfo;
    server.close(() => resume(Effect.succeed(address.port)));
  });
});

const serve = (entry: string, port: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let output = "";
      const child = NodeChildProcess.spawn("node", [entry], {
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (output += String(chunk)));
      return { child, output: () => output };
    }),
    ({ child }) => Effect.sync(() => child.kill("SIGKILL")),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

describe("Next.js Node serve entry", { concurrent: false }, () => {
  it(
    "serves a real build without reloading next.config.ts at runtime",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fixture({
            "app/layout.jsx":
              "export default function Layout({children}) {return <html><body>{children}</body></html>}",
            "app/page.jsx":
              "export default function Home() {return <h1>Node Next</h1>}",
            "app/api/echo/route.js":
              "export async function POST(request) {return Response.json({value:await request.text()})}",
            "next.config.ts":
              'import type { NextConfig } from "next";\nconst config: NextConfig = { basePath: "/app", experimental: { cpus: 1 } };\nexport default config;\n',
          });
          const output = yield* makeNodeTarget().build!({
            root,
            framework: "nextjs",
          });
          expect(output.serverModules?.[0]?.name).toBe(SERVER_ENTRY_NAME);
          // Any runtime load of the config now fails the server loudly.
          yield* fs.writeFileString(
            path.join(root, "next.config.ts"),
            'throw new Error("next.config.ts was reloaded at runtime");\n',
          );
          const port = yield* freePort;
          const server = yield* serve(path.join(root, SERVER_ENTRY_NAME), port);
          const get = (pathname: string, init?: RequestInit) =>
            Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${port}${pathname}`, init),
            );
          const health = yield* get("/health").pipe(
            Effect.retry({
              schedule: Schedule.spaced("250 millis"),
              times: 80,
              while: () => server.child.exitCode === null,
            }),
            Effect.mapError(
              (cause) =>
                new Error(
                  `serve-node.mjs never became ready:\n${server.output()}`,
                  {
                    cause,
                  },
                ),
            ),
          );
          expect(health.status).toBe(200);
          const page = yield* get("/app");
          const html = yield* Effect.tryPromise(() => page.text());
          expect(page.status, server.output()).toBe(200);
          expect(html).toContain("Node Next");
          const post = yield* get("/app/api/echo", {
            method: "POST",
            body: "value",
          });
          expect(post.status).toBe(200);
          expect(yield* Effect.tryPromise(() => post.json())).toEqual({
            value: "value",
          });
          expect(server.output()).not.toContain("reloaded at runtime");
        }),
      ),
    180_000,
  );
  it(
    'rejects `output: "export"` at build time',
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* fixture({
            "app/layout.jsx":
              "export default function Layout({children}) {return <html><body>{children}</body></html>}",
            "app/page.jsx":
              "export default function Home() {return <h1>Static Next</h1>}",
            "next.config.mjs":
              'export default { output: "export", experimental: { cpus: 1 } };',
          });
          const error = yield* makeNodeTarget().build!({
            root,
            framework: "nextjs",
          }).pipe(Effect.flip);
          expect(error.message).toContain('`output: "export"`');
          expect(error.message).toContain("cannot run on the Node target");
        }),
      ),
    180_000,
  );
});
