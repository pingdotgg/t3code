import * as Effect from "effect/Effect";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import type * as ViteModule from "vite";
import { loadProjectModule, resolveProjectPackageDirectory } from "../index.ts";
import { run } from "./helpers.ts";

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
});
