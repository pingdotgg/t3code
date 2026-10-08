// @effect-diagnostics nodeBuiltinImport:off - Resolve the native dependency through its installed SDK package.
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class CuaLinuxSdkMissingError extends Schema.TaggedError<CuaLinuxSdkMissingError>()(
  "CuaLinuxSdkMissingError",
  { filePath: Schema.String },
) {}

/** Replace the SDK's native library as well as the daemon; they are one build. */
export const stageCuaLinuxSdk = Effect.fn("stageCuaLinuxSdk")(function* (input: {
  readonly arch: string;
  readonly bundleDir: string;
  readonly nodeModulesDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sdkDir = yield* fs.realPath(path.join(input.nodeModulesDir, "@trycua/cua-driver"));
  const nativePackage = `@trycua/cua-driver-linux-${input.arch}-gnu/package.json`;
  const nativeManifest = yield* Effect.try({
    try: () => NodeModule.createRequire(path.join(sdkDir, "package.json")).resolve(nativePackage),
    catch: () => new CuaLinuxSdkMissingError({ filePath: nativePackage }),
  });
  const destination = path.join(path.dirname(nativeManifest), "libcua_driver_sdk.so");
  if (!(yield* fs.exists(destination))) {
    return yield* new CuaLinuxSdkMissingError({ filePath: destination });
  }
  // pnpm may hardlink this file into its store. Unlink before replacing it so
  // packaging cannot modify another checkout's upstream SDK.
  yield* fs.remove(destination);
  yield* fs.copyFile(path.join(input.bundleDir, "libcua_driver_sdk.so"), destination);
});
