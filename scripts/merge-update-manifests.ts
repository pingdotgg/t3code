#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
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

  const primaryManifest = parsePlatformUpdateManifest(
    platform,
    yield* fs.readFileString(primaryPath),
    primaryPath,
  );
  const secondaryManifest = parsePlatformUpdateManifest(
    platform,
    yield* fs.readFileString(secondaryPath),
    secondaryPath,
  );
  const merged = mergePlatformUpdateManifests(platform, primaryManifest, secondaryManifest);

  yield* fs.writeFileString(outputPath, serializePlatformUpdateManifest(platform, merged));
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
