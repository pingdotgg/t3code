import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { layerTest as configLayerTest } from "../config.ts";
import { providerCliSetup } from "./providerCliSettings.ts";

const encodeInstalled = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ executable: Schema.String })),
);

it.effect(
  "new instances share the downloaded runtime while custom paths and external servers keep their owner",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-settings-" });
      const directory = path.join(baseDir, "tools", "provider-clis", "opencode");
      const executable = path.join(directory, "version", "opencode");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "fixture");
      yield* fs.writeFileString(
        path.join(directory, "installed.json"),
        yield* encodeInstalled({
          executable,
        }),
      );
      yield* Effect.gen(function* () {
        expect(yield* providerCliSetup("opencode", { binaryPath: "opencode" })).toMatchObject({
          binaryPath: executable,
          managed: true,
          available: true,
        });
        expect(
          yield* providerCliSetup("opencode", { binaryPath: "/custom/opencode" }),
        ).toMatchObject({
          binaryPath: "/custom/opencode",
          managed: false,
          capabilities: { canInstall: false },
        });
        expect(
          yield* providerCliSetup("opencode", {
            binaryPath: "opencode",
            serverUrl: "https://remote.example",
          }),
        ).toMatchObject({
          binaryPath: "opencode",
          managed: false,
          capabilities: { canInstall: false },
        });
      }).pipe(Effect.provide(configLayerTest(baseDir, baseDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
