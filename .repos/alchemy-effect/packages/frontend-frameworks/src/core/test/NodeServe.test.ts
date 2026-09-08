import { describe, expect, it } from "vitest";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  makeNodeServeEntrySource,
  pinNodeServeModule,
  relativeClientDirExpression,
} from "../NodeServe.ts";
import { toOutputFile, type BuildOutput } from "../index.ts";
import * as Effect from "effect/Effect";

describe("NODE_BUNDLE_CONDITIONS", () => {
  it("is node-first and excludes workerd / aws-sdk", () => {
    expect(NODE_BUNDLE_CONDITIONS).toEqual([
      "node",
      "import",
      "module",
      "default",
    ]);
    expect(NODE_BUNDLE_CONDITIONS).not.toContain("workerd");
  });
});

describe("relativeClientDirExpression", () => {
  it("emits an import.meta.url-relative file URL", () => {
    expect(
      relativeClientDirExpression(
        "/project/dist/server/serve-node.mjs",
        "/project/dist/client",
      ),
    ).toBe(`fileURLToPath(new URL("../client/", import.meta.url))`);
  });
});

describe("makeNodeServeEntrySource", () => {
  it("listens on PORT, answers /health, serves static files, then the fetch handler", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `fileURLToPath(new URL("../client/", import.meta.url))`,
      handler: {
        kind: "fetch",
        imports: `import { handler } from "./index.mjs";`,
        expr: "handler",
      },
    });
    expect(source).toContain("/health");
    expect(source).toContain("process.env.PORT");
    expect(source).toContain("http.createServer(async (req, res) => {");
    expect(source).toContain("server.listen");
    expect(source).toContain("lookupStatic");
    expect(source).toContain("max-age=31536000, immutable");
    expect(source).toContain(`import { handler } from "./index.mjs";`);
    expect(source).not.toContain("aws-lambda");
    expect(source).not.toContain("cloudflare:");
    expect(source).not.toContain("streamifyResponse");
  });

  it("falls back to index.html for SPA not-found handling", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `" /assets "`,
      handler: {
        kind: "fetch",
        imports: "",
        expr: "handler",
      },
      notFoundHandling: "spa",
    });
    expect(source).toContain('lookupStatic("/index.html")');
  });

  it("serves 404.html with status 404", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `" /assets "`,
      handler: {
        kind: "fetch",
        imports: "",
        expr: "handler",
      },
      notFoundHandling: "404-page",
    });
    expect(source).toContain('lookupStatic("/404.html")');
    expect(source).toContain("sendFile(res, notFound, 404)");
  });

  it("looks up about.html for drop-trailing-slash", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `" /assets "`,
      handler: {
        kind: "fetch",
        imports: "",
        expr: "handler",
      },
      htmlHandling: "drop-trailing-slash",
    });
    expect(source).toContain('base + ".html"');
  });

  it("awaits a Node (req, res) listener from an async createServer callback", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `" /assets "`,
      handler: {
        kind: "node",
        imports: `import { handler } from "./index.mjs";`,
        expr: "handler",
      },
    });
    expect(source).toContain("http.createServer(async (req, res) => {");
    expect(source).toContain("endedGet(req)");
    expect(source).toContain('delete headers["content-length"]');
    expect(source).toContain("new http.IncomingMessage(req.socket)");
    expect(source).toContain("fake.push(null)");
    expect(source).not.toContain("void (async () => {");
    expect(source).not.toContain("fetchFromNode");
    expect(source).not.toContain("PassThrough");
  });

  it("omits a handler for assets-only sites and 404s after static lookup", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `fileURLToPath(new URL("./", import.meta.url))`,
      notFoundHandling: "spa",
    });
    expect(source).toContain("/health");
    expect(source).toContain("lookupStatic");
    expect(source).toContain('lookupStatic("/index.html")');
    expect(source).toContain('res.end("Not Found")');
    expect(source).not.toContain("toRequest");
    expect(source).not.toContain("endedGet");
    expect(source).not.toContain('from "node:stream"');
    expect(source).toContain("const isRoot = false");
  });

  it("does not map GET / onto public/index.html (SSR home stays on the handler)", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `fileURLToPath(new URL("../client/", import.meta.url))`,
      handler: {
        kind: "node",
        imports: `import { handler } from "./index.mjs";`,
        expr: "handler",
      },
    });
    expect(source).toContain(
      'const isRoot = (urlPath === "/" || urlPath === "")',
    );
    expect(source).toContain("existingFile(base, !isRoot)");
  });
});

describe("pinNodeServeModule", () => {
  it("places the serve entry first", async () => {
    const serve = await Effect.runPromise(
      toOutputFile(`server/${NODE_SERVE_ENTRY_FILE_NAME}`, "serve"),
    );
    const other = await Effect.runPromise(
      toOutputFile("server/index.mjs", "index"),
    );
    const output: BuildOutput = {
      clientDirectory: "/dist/client",
      serverModules: [other],
      externalWorkspaces: new Set(),
    };
    const pinned = pinNodeServeModule(output, serve);
    expect(pinned.serverModules?.map((module_) => module_.name)).toEqual([
      `server/${NODE_SERVE_ENTRY_FILE_NAME}`,
      "server/index.mjs",
    ]);
  });
});
