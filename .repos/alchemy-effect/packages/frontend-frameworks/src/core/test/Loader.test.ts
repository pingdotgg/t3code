import * as Effect from "effect/Effect";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import type * as ViteModule from "vite";
import { loadProjectModule, resolveProjectPackageDirectory } from "../index.ts";
import { makeProject, run } from "./helpers.ts";

const packageRoot = NodePath.resolve(import.meta.dirname, "..");

describe("loadProjectModule", () => {
  it("loads a module from the project's dependency tree", async () => {
    const mod = await run(
      loadProjectModule<typeof ViteModule>(packageRoot, "vite"),
    );
    expect(typeof mod.createBuilder).toBe("function");
  });

  it("fails with ModuleLoadError for an unresolvable specifier", async () => {
    const result = await run(
      Effect.result(
        loadProjectModule(packageRoot, "definitely-not-a-real-package-xyz"),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("ModuleLoadError");
    }
  });
});

describe("resolveProjectPackageDirectory", () => {
  it("resolves the directory containing a package's package.json", async () => {
    const dir = await run(resolveProjectPackageDirectory(packageRoot, "vite"));
    const packageJson = JSON.parse(
      await NodeFsPromises.readFile(NodePath.join(dir, "package.json"), "utf8"),
    ) as { name: string };
    expect(packageJson.name).toBe("vite");
  });

  it("resolves an ESM-only package that does not export package.json", async () => {
    const root = await makeProject({
      "node_modules/vinext/package.json": JSON.stringify({
        name: "vinext",
        type: "module",
        exports: { ".": { import: "./index.js" } },
      }),
      "node_modules/vinext/index.js": "export {}",
    });
    const dir = await run(resolveProjectPackageDirectory(root, "vinext"));
    expect(dir).toBe(NodePath.join(root, "node_modules", "vinext"));
  });

  it("resolves a hoisted package from a parent node_modules", async () => {
    const workspace = await makeProject({
      "node_modules/vinext/package.json": JSON.stringify({
        name: "vinext",
        type: "module",
        exports: { ".": { import: "./index.js" } },
      }),
      "node_modules/vinext/index.js": "export {}",
      "apps/site/package.json": JSON.stringify({
        name: "site",
        private: true,
        type: "module",
      }),
    });
    const project = NodePath.join(workspace, "apps", "site");
    const dir = await run(resolveProjectPackageDirectory(project, "vinext"));
    expect(dir).toBe(NodePath.join(workspace, "node_modules", "vinext"));
  });
});
