import { sortServerModules, type OutputFile } from "../../core/index.ts";
import { describe, expect, it } from "vitest";
import {
  listEdgeFunctions,
  DEFAULT_COMPATIBILITY_DATE,
  hasDoQueueClass,
  makeRunnerConfig,
  toRuntimeModules,
  WORKER_ENTRY_MODULE,
} from "../Nextjs.ts";

const file = (name: string, content: string | Uint8Array): OutputFile => ({
  name,
  content,
  hash: "test",
});

describe("makeRunnerConfig", () => {
  it("applies defaults", () => {
    const config = makeRunnerConfig("/app");
    expect(config).toEqual({
      appDir: "/app",
      configPath: "open-next.config.ts",
      compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
      skipNextBuild: false,
      minify: false,
      debug: false,
      buildCommand: undefined,
    });
  });

  it("honors options", () => {
    const config = makeRunnerConfig("/app", {
      vite: { compatibilityDate: "2026-01-01" },
      nextjs: {
        configPath: "custom.config.ts",
        buildCommand: "npx next build --debug",
        skipNextBuild: true,
        minify: true,
        debug: true,
      },
    });
    expect(config).toEqual({
      appDir: "/app",
      configPath: "custom.config.ts",
      compatibilityDate: "2026-01-01",
      skipNextBuild: true,
      minify: true,
      debug: true,
      buildCommand: "npx next build --debug",
    });
  });
});

describe("toRuntimeModules", () => {
  it("maps extensions to cloudflare-runtime module types", () => {
    const modules = toRuntimeModules([
      file("worker/worker.js", "entry"),
      file("worker/chunks/a.mjs", "chunk"),
      file("worker/legacy.cjs", "cjs"),
      file("worker/data.json", `{"a":1}`),
      file("worker/wasm.wasm", new Uint8Array([0, 97, 115, 109])),
      file("worker/blob.bin", new Uint8Array([1, 2, 3])),
      file("worker/readme.txt", "text"),
    ]);
    expect(modules.map((module) => [module.name, module.type])).toEqual([
      ["worker/worker.js", "ESModule"],
      ["worker/chunks/a.mjs", "ESModule"],
      ["worker/legacy.cjs", "CommonJsModule"],
      ["worker/data.json", "Json"],
      ["worker/wasm.wasm", "Wasm"],
      ["worker/blob.bin", "Data"],
      ["worker/readme.txt", "Text"],
    ]);
  });

  it("drops sourcemaps", () => {
    expect(toRuntimeModules([file("worker/worker.js.map", "{}")])).toEqual([]);
  });

  it("normalizes buffered text content to strings and text to bytes", () => {
    const [text] = toRuntimeModules([
      file("worker/worker.js", Buffer.from("hello")),
    ]);
    expect(text).toEqual({
      name: "worker/worker.js",
      type: "ESModule",
      content: "hello",
    });
    const [bytes] = toRuntimeModules([file("worker/blob.bin", "abc")]);
    expect(bytes?.type).toBe("Data");
    expect(bytes?.content).toBeInstanceOf(Uint8Array);
  });
});

describe("hasDoQueueClass", () => {
  it("detects the DO queue class in string and buffered entries", () => {
    expect(
      hasDoQueueClass(file("worker/worker.js", "export { DOQueueHandler }")),
    ).toBe(true);
    expect(
      hasDoQueueClass(
        file("worker/worker.js", Buffer.from("class DOQueueHandler")),
      ),
    ).toBe(true);
    expect(hasDoQueueClass(file("worker/worker.js", "export default {}"))).toBe(
      false,
    );
    expect(hasDoQueueClass(undefined)).toBe(false);
  });
});

describe("server module ordering", () => {
  it("sorts the worker entry first", () => {
    const sorted = sortServerModules(
      [
        file("worker/chunks/a.js", "a"),
        file(WORKER_ENTRY_MODULE, "entry"),
        file("worker/chunks/b.js", "b"),
      ],
      WORKER_ENTRY_MODULE,
    );
    expect(sorted[0]?.name).toBe(WORKER_ENTRY_MODULE);
    expect(WORKER_ENTRY_MODULE).toBe("worker/worker.js");
  });
});

describe("listEdgeFunctions", () => {
  it("returns edge function paths from the middleware manifest", () => {
    expect(
      listEdgeFunctions({
        middleware: { "/": { files: [] } },
        functions: {
          "/api/edge/route": { files: [] },
          "/edge-page": { files: [] },
        },
      }),
    ).toEqual(["/api/edge/route", "/edge-page"]);
  });

  it("treats middleware-only manifests (and junk) as edge-free", () => {
    expect(listEdgeFunctions({ middleware: { "/": { files: [] } } })).toEqual(
      [],
    );
    expect(listEdgeFunctions({})).toEqual([]);
    expect(listEdgeFunctions(undefined)).toEqual([]);
    expect(listEdgeFunctions("nope")).toEqual([]);
  });
});
