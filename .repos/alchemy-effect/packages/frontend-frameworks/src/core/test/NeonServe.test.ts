import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";
import { makeNeonServeEntrySource } from "../NeonServe.ts";
import type { NodeServeEntryOptions } from "../NodeServe.ts";

type Entry = { default: { fetch(request: Request): Promise<Response> } };
const entry = (
  options: NodeServeEntryOptions,
  files: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-neon-fetch-",
    });
    for (const [name, content] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(root, name)), {
        recursive: true,
      });
      yield* fs.writeFileString(path.join(root, name), content);
    }
    const source = makeNeonServeEntrySource({
      clientDirExpression: JSON.stringify(root),
      ...options,
    }).replace(
      'from "srvx/node"',
      `from ${JSON.stringify(import.meta.resolve("srvx/node"))}`,
    );
    const specifier = yield* Effect.sync(
      () =>
        `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`,
    );
    return yield* Effect.tryPromise(() => import(specifier) as Promise<Entry>);
  });
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | import("effect/Scope").Scope
  >,
) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
const call = (module: Entry, pathname: string, method = "GET") =>
  Effect.tryPromise(() =>
    module.default.fetch(
      new Request(`https://function.neon.run${pathname}`, { method }),
    ),
  );
const text = (response: Response) => Effect.tryPromise(() => response.text());

describe("Neon Fetch entry", () => {
  it("exports Fetch without binding a listening socket", () => {
    const source = makeNeonServeEntrySource({});
    expect(source).toContain("export default");
    expect(source).not.toContain(".listen(");
    expect(source).not.toContain("Bun.");
    expect(source).not.toContain("workerd");
  });
  it("serves assets and deep SPA paths with equivalent HEAD headers", () =>
    run(
      Effect.gen(function* () {
        const module = yield* entry(
          { notFoundHandling: "spa" },
          { "index.html": "<h1>Neon</h1>", "app.css": "body{color:red}" },
        );
        const response = yield* call(module, "/deep/link");
        expect(yield* text(response)).toBe("<h1>Neon</h1>");
        const head = yield* call(module, "/deep/link", "HEAD");
        expect(head.status).toBe(200);
        expect(head.headers.get("content-type")).toBe(
          response.headers.get("content-type"),
        );
        expect(head.headers.get("content-length")).toBe(
          response.headers.get("content-length"),
        );
        expect(yield* text(head)).toBe("");
        expect(
          (yield* call(module, "/app.css")).headers.get("content-type"),
        ).toContain("text/css");
        expect((yield* call(module, "/", "POST")).status).toBe(404);
      }),
    ));
  it("uses custom 404 content and extensionless HTML", () =>
    run(
      Effect.gen(function* () {
        const module = yield* entry(
          { notFoundHandling: "404-page", htmlHandling: "drop-trailing-slash" },
          { "about.html": "About", "404.html": "Missing" },
        );
        expect(yield* text(yield* call(module, "/about"))).toBe("About");
        const missing = yield* call(module, "/missing");
        expect(missing.status).toBe(404);
        expect(yield* text(missing)).toBe("Missing");
        expect(yield* text(yield* call(module, "/missing", "HEAD"))).toBe("");
      }),
    ));
  it("rejects malformed and secret-file paths and never serves generated code", () =>
    run(
      Effect.gen(function* () {
        const module = yield* entry(
          {},
          {
            ".env": "secret",
            "serve-neon.mjs": "secret",
            "index.html": "home",
          },
        );
        expect((yield* call(module, "/%zz")).status).toBe(400);
        expect((yield* call(module, "/%00")).status).toBe(400);
        expect((yield* call(module, "/%5c.env")).status).toBe(400);
        expect((yield* call(module, "/.env")).status).toBe(404);
        expect((yield* call(module, "/serve-neon.mjs")).status).toBe(404);
      }),
    ));
  it("leaves SSR home routing to the handler and preserves its exact response", () =>
    run(
      Effect.gen(function* () {
        const module = yield* entry(
          {
            handler: {
              kind: "fetch",
              imports: "const response = new Response('SSR');",
              expr: "() => response",
            },
          },
          { "index.html": "static" },
        );
        const first = yield* call(module, "/");
        const second = yield* call(module, "/");
        expect(first).toBe(second);
        expect(yield* text(first)).toBe("SSR");
      }),
    ));
  it("preserves streaming and multiple cookies from Fetch handlers", () =>
    run(
      Effect.gen(function* () {
        const module = yield* entry({
          handler: {
            kind: "fetch",
            imports: "",
            expr: `() => { const h = new Headers(); h.append("set-cookie", "a=1; Path=/"); h.append("set-cookie", "b=2; Path=/"); return new Response(new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode("first")); c.enqueue(new TextEncoder().encode("second")); c.close();}}), {headers:h}); }`,
          },
        });
        const response = yield* call(module, "/stream");
        expect(response.headers.getSetCookie()).toHaveLength(2);
        expect(yield* text(response)).toBe("firstsecond");
      }),
    ));
  it("adapts Node handlers, bodies, redirects, cookies, and bodyless responses", () =>
    run(
      Effect.gen(function* () {
        const module = yield* entry({
          handler: {
            kind: "node",
            imports: "",
            expr: `(req, res) => { if (req.url === '/empty') {res.writeHead(204); res.end(); return;} if (req.url === '/redirect') {res.writeHead(302, {location:'/next'}); res.end(); return;} res.setHeader('set-cookie', ['a=1', 'b=2']); res.setHeader('content-type', 'text/plain'); let body=''; req.on('data', x => body += x); req.on('end', () => res.end(body || 'hello')); }`,
          },
        });
        const post = yield* Effect.tryPromise(() =>
          module.default.fetch(
            new Request("https://function.neon.run/echo", {
              method: "POST",
              body: "posted",
            }),
          ),
        );
        expect(yield* text(post)).toBe("posted");
        expect(post.headers.getSetCookie()).toHaveLength(2);
        expect((yield* call(module, "/empty")).status).toBe(204);
        const redirect = yield* call(module, "/redirect");
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("location")).toBe("/next");
      }),
    ));
  it("returns Node response headers while an async handler is still streaming", () =>
    run(
      Effect.gen(function* () {
        const module = yield* entry({
          handler: {
            kind: "node",
            imports: "",
            expr: "async (req, res) => {res.setHeader('content-type','text/event-stream'); res.write('data: first\\n\\n'); await new Promise(resolve=>setTimeout(resolve,1000)); res.end('data: last\\n\\n');}",
          },
        });
        const response = yield* call(module, "/stream").pipe(
          Effect.timeout("250 millis"),
        );
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(yield* text(response)).toContain("data: last");
      }),
    ));
  it("does not mistake a Node framework parsed-URL argument for Connect middleware", () =>
    run(
      Effect.gen(function* () {
        const module = yield* entry({
          handler: {
            kind: "node",
            imports: "",
            expr: "(req, res, parsedUrl) => {res.end(parsedUrl === undefined ? req.url : 'incorrect middleware callback')}",
          },
        });
        expect(yield* text(yield* call(module, "/route?x=1"))).toBe(
          "/route?x=1",
        );
      }),
    ));
  it("reconstructs the trusted custom hostname without changing path or query", () =>
    run(
      Effect.gen(function* () {
        const module = yield* entry({
          handler: {
            kind: "fetch",
            imports: "",
            expr: "request => new Response(request.url)",
          },
        });
        const response = yield* Effect.tryPromise(() =>
          module.default.fetch(
            new Request("https://function.neon.run/account?q=1", {
              headers: { "x-forwarded-host": "app.example.com" },
            }),
          ),
        );
        expect(yield* text(response)).toBe(
          "https://app.example.com/account?q=1",
        );
      }),
    ));
});
