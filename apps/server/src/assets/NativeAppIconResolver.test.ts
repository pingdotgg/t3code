import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

it.effect("resolves the exact bundle path without Spotlight and caches the converted icon", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bundle-icon-" });
    const bundle = path.join(root, "Build Output", "My App.app");
    const resources = path.join(bundle, "Contents", "Resources");
    yield* fs.makeDirectory(resources, { recursive: true });
    yield* fs.writeFileString(path.join(resources, "AppIcon.icns"), "icon");
    const commands: string[] = [];
    const spawner = Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
      string: (command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return "";
          commands.push(command.command);
          if (command.command === "/usr/bin/plutil") return "AppIcon";
          if (command.command === "/usr/bin/sips") {
            yield* fs.writeFileString(String(command.args.at(-1)), "converted icon");
          }
          return "";
        }),
    });
    yield* Effect.gen(function* () {
      const resolver = yield* NativeAppIconResolver.make;
      const reference = { _tag: "app-path" as const, path: bundle };
      const icon = yield* resolver.resolve(reference);
      expect(icon).not.toBeNull();
      if (icon === null) return;
      expect(yield* fs.readFileString(icon)).toBe("converted icon");
      expect(yield* resolver.resolve(reference)).toBe(icon);
      expect(yield* resolver.resolve({ _tag: "app-path", path: "~/Build Output/My App.app" })).toBe(
        icon,
      );
      expect(commands.filter((command) => command === "/usr/bin/sips")).toHaveLength(1);
      expect(commands).not.toContain("/usr/bin/mdfind");
      expect(yield* resolver.resolve({ _tag: "app-path", path: "relative.app" })).toBeNull();
      expect(yield* resolver.resolve({ _tag: "app-path", path: root })).toBeNull();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawner,
          ServerConfig.ServerConfig.layerTest(root, { prefix: "t3-native-icon-config-" }),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.HomeDirectory, root),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
