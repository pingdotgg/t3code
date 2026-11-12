// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { build } from "vite-plus";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import type * as AtomModule from "./atom.ts";
import type * as AtomReactModule from "./atom-react.ts";
import { t3PluginWeb } from "./vite.ts";
import { HOST_ATOM_EXPORTS, HOST_ATOM_REACT_EXPORTS } from "./web.ts";

const exampleRoot = NodePath.join(import.meta.dirname, "../examples/quick-notes");

describe("t3PluginWeb", () => {
  it("bundles a web plugin without React and reads shared modules from the host", async () => {
    const output = await build({
      root: exampleRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [t3PluginWeb()],
      build: { write: false, minify: false },
    });
    const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) =>
      "output" in result ? result.output.filter((item) => item.type === "chunk") : [],
    );

    expect(chunks.map((chunk) => chunk.fileName)).toEqual(["web.js"]);
    const [chunk] = chunks;
    expect(chunk?.moduleIds.filter((id) => id.includes("node_modules"))).toEqual([]);
    expect(chunk?.code).not.toMatch(/^import /m);
    // The example's atoms and hooks come from T3, not a bundled copy of effect.
    for (const key of ["react", "jsxRuntime", "ui", "atom", "atomReact"]) {
      expect(chunk?.code).toContain(`globalThis.__t3PluginHost.${key}`);
    }
  });

  it("keeps a lazily imported module inside web.js, since T3 loads no other file", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-plugin-lazy-"));
    await using _root = { [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true }) };
    await NodeFSP.writeFile(NodePath.join(root, "later.ts"), 'export const later = "later";\n');
    await NodeFSP.writeFile(
      NodePath.join(root, "web.tsx"),
      'export default { activate: () => import("./later.ts") };\n',
    );

    const output = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [t3PluginWeb()],
      build: { write: false, minify: false },
    });
    const files = (Array.isArray(output) ? output : [output]).flatMap((result) =>
      "output" in result ? result.output.map((item) => item.fileName) : [],
    );
    expect(files).toEqual(["web.js"]);
  });

  it.each([
    [
      "a stylesheet",
      { "web.css": "p { color: red; }", "web.tsx": 'import "./web.css";\nexport default {};\n' },
      "web.css, which T3 never loads. Import the CSS with `?inline`",
    ],
    [
      "a worker",
      {
        "worker.ts": "self.postMessage(1);\n",
        "web.tsx":
          'import Worker from "./worker.ts?worker";\nexport default { activate: () => new Worker() };\n',
      },
      "which T3 never loads. Import a worker with `?worker&inline`",
    ],
  ])(
    "refuses %s written beside web.js, which T3 would never load",
    async (_name, files, message) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-plugin-extra-"));
      await using _root = { [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true }) };
      for (const [name, text] of Object.entries(files)) {
        await NodeFSP.writeFile(NodePath.join(root, name), text);
      }

      await expect(
        build({
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [t3PluginWeb()],
          build: { write: false, minify: false },
        }),
      ).rejects.toThrow(message);
    },
  );
});

describe("shared atom modules", () => {
  // T3 hands a plugin only the listed names, so a name the SDK declares but T3 doesn't list breaks.
  it("lists exactly the values the SDK's atom modules declare", () => {
    expectTypeOf<keyof typeof AtomModule>().toEqualTypeOf<(typeof HOST_ATOM_EXPORTS)[number]>();
    expectTypeOf<keyof typeof AtomReactModule>().toEqualTypeOf<
      (typeof HOST_ATOM_REACT_EXPORTS)[number]
    >();
  });
});
