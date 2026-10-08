import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { stageCuaLinuxSdk } from "./cua-linux-bundle.ts";

it.layer(NodeServices.layer)("stageCuaLinuxSdk", (it) => {
  it.effect.each(["hoisted", "pnpm"] as const)(
    "replaces the %s SDK without changing a shared store file",
    (layout) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cua-sdk-stage-" });
        const nodeModulesDir = path.join(root, "node_modules");
        const deps =
          layout === "pnpm" ? path.join(nodeModulesDir, ".pnpm/sdk/node_modules") : nodeModulesDir;
        const sdk = path.join(deps, "@trycua/cua-driver");
        const native = path.join(deps, "@trycua/cua-driver-linux-x64-gnu");
        yield* fs.makeDirectory(sdk, { recursive: true });
        yield* fs.makeDirectory(native, { recursive: true });
        yield* fs.writeFileString(path.join(sdk, "package.json"), '{"name":"@trycua/cua-driver"}');
        yield* fs.writeFileString(
          path.join(native, "package.json"),
          '{"name":"@trycua/cua-driver-linux-x64-gnu"}',
        );
        if (layout === "pnpm") {
          yield* fs.makeDirectory(path.join(nodeModulesDir, "@trycua"), { recursive: true });
          yield* fs.symlink(sdk, path.join(nodeModulesDir, "@trycua/cua-driver"));
        }
        const shared = path.join(root, "store-library");
        yield* fs.writeFileString(shared, "upstream");
        const library = path.join(native, "libcua_driver_sdk.so");
        yield* fs.link(shared, library);
        const bundleDir = path.join(root, "bundle");
        yield* fs.makeDirectory(bundleDir);
        yield* fs.writeFileString(path.join(bundleDir, "libcua_driver_sdk.so"), "patched");
        yield* stageCuaLinuxSdk({ arch: "x64", bundleDir, nodeModulesDir });
        expect(yield* fs.readFileString(library)).toBe("patched");
        expect(yield* fs.readFileString(shared)).toBe("upstream");
        yield* fs.remove(library);
        const error = yield* Effect.flip(
          stageCuaLinuxSdk({ arch: "x64", bundleDir, nodeModulesDir }),
        );
        expect(error._tag).toBe("CuaLinuxSdkMissingError");
      }).pipe(Effect.scoped),
  );
});
