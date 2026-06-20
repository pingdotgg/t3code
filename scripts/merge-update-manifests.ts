#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  attemptUpdateManifest,
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
  type UpdateManifest,
} from "./lib/update-manifest.ts";

const UpdateManifestPlatform = Schema.Literals(["mac", "win"]);
export type UpdateManifestPlatform = typeof UpdateManifestPlatform.Type;

function getPlatformLabel(platform: UpdateManifestPlatform): string {
  return platform === "mac" ? "macOS" : "Windows";
}

export function parsePlatformUpdateManifest(
  platform: UpdateManifestPlatform,
  raw: string,
  sourcePath: string,
): UpdateManifest {
  return parseUpdateManifest(raw, sourcePath, getPlatformLabel(platform));
}

export function mergePlatformUpdateManifests(
  platform: UpdateManifestPlatform,
  primary: UpdateManifest,
  secondary: UpdateManifest,
): UpdateManifest {
  return mergeUpdateManifests(primary, secondary, getPlatformLabel(platform));
}

export function serializePlatformUpdateManifest(
  platform: UpdateManifestPlatform,
  manifest: UpdateManifest,
): string {
  return serializeUpdateManifest(manifest, {
    platformLabel: getPlatformLabel(platform),
  });
}

export const mergeUpdateManifestFiles = Effect.fn("mergeUpdateManifestFiles")(function* (
  platform: UpdateManifestPlatform,
  primaryPathArg: string,
  secondaryPathArg: string,
  outputPathArg: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const primaryPath = path.resolve(primaryPathArg);
  const secondaryPath = path.resolve(secondaryPathArg);
  const outputPath = path.resolve(outputPathArg ?? primaryPathArg);

  const primaryRaw = yield* fs.readFileString(primaryPath);
  const primaryManifest = yield* attemptUpdateManifest(() =>
    parsePlatformUpdateManifest(platform, primaryRaw, primaryPath),
  );
  const secondaryRaw = yield* fs.readFileString(secondaryPath);
  const secondaryManifest = yield* attemptUpdateManifest(() =>
    parsePlatformUpdateManifest(platform, secondaryRaw, secondaryPath),
  );
  const merged = yield* attemptUpdateManifest(() =>
    mergePlatformUpdateManifests(platform, primaryManifest, secondaryManifest),
  );

  const serialized = yield* attemptUpdateManifest(() =>
    serializePlatformUpdateManifest(platform, merged),
  );
  yield* fs.writeFileString(outputPath, serialized);
});

export const mergeUpdateManifestsCommand = Command.make(
  "merge-update-manifests",
  {
    platform: Flag.choice("platform", UpdateManifestPlatform.literals).pipe(
      Flag.withDescription("Update manifest platform."),
    ),
    primaryPath: Argument.string("primary-path").pipe(
      Argument.withDescription("Primary update manifest path. Defaults to the output path."),
    ),
    secondaryPath: Argument.string("secondary-path").pipe(
      Argument.withDescription(
        "Secondary update manifest path to merge into the primary manifest.",
      ),
    ),
    outputPath: Argument.string("output-path").pipe(
      Argument.withDescription("Optional output path for the merged manifest."),
      Argument.optional,
    ),
  },
  ({ platform, primaryPath, secondaryPath, outputPath }) =>
    mergeUpdateManifestFiles(
      platform,
      primaryPath,
      secondaryPath,
      Option.getOrUndefined(outputPath),
    ),
).pipe(Command.withDescription("Merge two Electron updater manifests into a multi-arch manifest."));

if (import.meta.main) {
  Command.run(mergeUpdateManifestsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
