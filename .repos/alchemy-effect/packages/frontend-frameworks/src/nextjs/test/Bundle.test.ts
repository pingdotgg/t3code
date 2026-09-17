import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundleWorker,
  CREATE_REQUIRE_BANNER,
  WORKER_ENTRY_NAME,
} from "../Bundle.ts";

/**
 * A synthetic `.open-next` output exercising the four final-bundle rules:
 * relative imports that must be inlined (`middleware/handler.mjs`,
 * `.build/durable-objects/*.js`), the dynamic server-handler import that must
 * stay a lazy chunk, an absolute `?module`-suffixed `.wasm` import, a
 * `cloudflare:*` external, and a CJS-style `require` of a node builtin.
 */
const makeOpenNextFixture = (root: string) => {
  const openNext = NodePath.join(root, ".open-next");
  NodeFs.mkdirSync(NodePath.join(openNext, "middleware"), { recursive: true });
  NodeFs.mkdirSync(NodePath.join(openNext, ".build", "durable-objects"), {
    recursive: true,
  });
  NodeFs.mkdirSync(NodePath.join(openNext, "server-functions", "default"), {
    recursive: true,
  });

  const wasmPath = NodePath.join(
    openNext,
    "server-functions",
    "default",
    "example.wasm",
  );
  // Minimal valid wasm header: "\0asm" + version 1.
  NodeFs.writeFileSync(
    wasmPath,
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );

  NodeFs.writeFileSync(
    NodePath.join(openNext, WORKER_ENTRY_NAME),
    [
      `import { env } from "cloudflare:workers";`,
      `import { handleMiddleware } from "./middleware/handler.mjs";`,
      `export { DOQueueHandler } from "./.build/durable-objects/queue.js";`,
      `export default {`,
      `  async fetch(request) {`,
      `    handleMiddleware(env);`,
      `    const { default: handler } = await import("./server-functions/default/handler.mjs");`,
      `    return handler(request);`,
      `  },`,
      `};`,
    ].join("\n"),
  );
  NodeFs.writeFileSync(
    NodePath.join(openNext, "middleware", "handler.mjs"),
    `export const handleMiddleware = () => "MIDDLEWARE_MARKER";`,
  );
  NodeFs.writeFileSync(
    NodePath.join(openNext, ".build", "durable-objects", "queue.js"),
    `export class DOQueueHandler {}`,
  );
  NodeFs.writeFileSync(
    NodePath.join(openNext, "server-functions", "default", "handler.mjs"),
    [
      // The absolute `?module` import OpenNext's setWranglerExternal leaves
      // behind "for wrangler to bundle".
      `import wasm from ${JSON.stringify(`${wasmPath}?module`)};`,
      // CJS-converted Next server code requires node builtins dynamically.
      `const pickRequire = () => require("fs");`,
      `export default () => ["HANDLER_MARKER", wasm, pickRequire];`,
    ].join("\n"),
  );
  return openNext;
};

describe("bundleWorker", () => {
  const root = NodeFs.mkdtempSync(
    NodePath.join(NodeOs.tmpdir(), "distilled-nextjs-bundle-"),
  );
  const outDirectory = NodePath.join(root, "dist", "worker");
  let files: Array<string> = [];

  beforeAll(async () => {
    const openNextDirectory = makeOpenNextFixture(root);
    await Effect.runPromise(bundleWorker({ openNextDirectory, outDirectory }));
    // Windows readdir yields backslash-separated relative paths; the
    // assertions below match POSIX module-name shapes.
    files = NodeFs.readdirSync(outDirectory, { recursive: true }).map((file) =>
      String(file).replaceAll("\\", "/"),
    );
  });

  afterAll(() => {
    NodeFs.rmSync(root, { recursive: true, force: true });
  });

  const read = (name: string) =>
    NodeFs.readFileSync(NodePath.join(outDirectory, name), "utf8");

  it("emits the worker entry with the createRequire banner", () => {
    expect(files).toContain(WORKER_ENTRY_NAME);
    const entry = read(WORKER_ENTRY_NAME);
    for (const line of CREATE_REQUIRE_BANNER.split("\n")) {
      expect(entry).toContain(line);
    }
    // The `import.meta.url ?? "file:///"` fallback is load-bearing: workerd
    // modules have an undefined import.meta.url.
    expect(entry).toContain(`import.meta.url ?? "file:///"`);
  });

  it("inlines the middleware and durable-object imports into the entry", () => {
    const entry = read(WORKER_ENTRY_NAME);
    expect(entry).toContain("MIDDLEWARE_MARKER");
    expect(entry).toContain("DOQueueHandler");
  });

  it("keeps the server handler a lazy chunk", () => {
    const entry = read(WORKER_ENTRY_NAME);
    expect(entry).not.toContain("HANDLER_MARKER");
    const chunks = files.filter(
      (file) => file.startsWith("chunks/") && file.endsWith(".js"),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((chunk) => read(chunk).includes("HANDLER_MARKER"))).toBe(
      true,
    );
  });

  it("keeps cloudflare:* and node:* imports external", () => {
    const entry = read(WORKER_ENTRY_NAME);
    expect(entry).toContain(`"cloudflare:workers"`);
    expect(entry).toContain(`"node:module"`);
  });

  it("copies ?module wasm imports out as .wasm files with relative imports", () => {
    const wasmFiles = files.filter((file) => file.endsWith(".wasm"));
    expect(wasmFiles.length).toBe(1);
    const chunks = files.filter(
      (file) => file.startsWith("chunks/") && file.endsWith(".js"),
    );
    const importer = chunks.find((chunk) =>
      read(chunk).includes("HANDLER_MARKER"),
    );
    expect(importer).toBeDefined();
    const content = read(importer!);
    expect(content).not.toContain("?module");
    expect(content).toContain(NodePath.basename(wasmFiles[0]!));
  });
});
