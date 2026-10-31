import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

it.effect("prefers the label provisioning writes into the base directory", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-label-" });
    yield* fileSystem.writeFileString(path.join(baseDir, "environment-label"), "  Boat sandbox\n");

    // No sudo, systemd, or writable /etc is needed for this path, which is why provisioning uses it.
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "workspace", baseDir });

    expect(label).toBe("Boat sandbox");
  }).pipe(Effect.provide(TestLayer)),
);
