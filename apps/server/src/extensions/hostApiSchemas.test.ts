import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { generateExtensionHostApi } from "../../scripts/extensionHostApi.ts";

it.effect("keeps the standalone SDK service types in sync with the server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sdkFile = yield* path.fromFileUrl(
      new URL("../../../../packages/extension-sdk/src/hostApi.generated.ts", import.meta.url),
    );
    expect(yield* fs.readFileString(sdkFile)).toBe(yield* generateExtensionHostApi());
  }).pipe(Effect.provide(NodeServices.layer)),
);
