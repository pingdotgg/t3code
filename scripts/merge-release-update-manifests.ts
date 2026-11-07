#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Argument, Command } from "effect/cli";

import { mergeUpdateManifestFiles, type UpdateManifestPlatform } from "./merge-update-manifests.ts";

interface ReleaseUpdateManifestMerge {
  readonly platform: UpdateManifestPlatform;
  readonly primary: string;
  readonly secondary: string;
  readonly output: string;
}

function incomplete(platform: string, detail: string): Error {
  return new Error(`Incomplete ${platform} updater manifests: ${detail}.`);
}

export function planReleaseUpdateManifestMerges(
  fileNames: ReadonlyArray<string>,
): ReadonlyArray<ReleaseUpdateManifestMerge> {
  const macArm64 = new Map<string, string>();
  const macX64 = new Map<string, string>();
  const winArm64 = new Map<string, string>();
  const winX64 = new Map<string, string>();

  for (const fileName of fileNames) {
    if (fileName.startsWith("builder-debug-")) continue;

    const macArm64Match = /^(.+)-mac\.yml$/u.exec(fileName);
    if (macArm64Match?.[1] !== undefined) {
      macArm64.set(macArm64Match[1], fileName);
      continue;
    }
    const macX64Match = /^(.+)-mac-x64\.yml$/u.exec(fileName);
    if (macX64Match?.[1] !== undefined) {
      macX64.set(macX64Match[1], fileName);
      continue;
    }
    const winMatch = /^(.+)-win-(arm64|x64)\.yml$/u.exec(fileName);
    if (winMatch?.[1] !== undefined) {
      (winMatch[2] === "arm64" ? winArm64 : winX64).set(winMatch[1], fileName);
    }
  }

  const plans: ReleaseUpdateManifestMerge[] = [];
  const macChannels = new Set([...macArm64.keys(), ...macX64.keys()]);
  if (macChannels.size === 0) throw incomplete("macOS", "no architecture manifests found");
  for (const channel of [...macChannels].toSorted()) {
    const arm64 = macArm64.get(channel);
    const x64 = macX64.get(channel);
    if (arm64 === undefined || x64 === undefined) {
      throw incomplete(
        "macOS",
        `${channel} is missing its ${arm64 === undefined ? "arm64" : "x64"} manifest`,
      );
    }
    plans.push({
      platform: "mac",
      primary: arm64,
      secondary: x64,
      output: arm64,
    });
  }

  const winChannels = new Set([...winArm64.keys(), ...winX64.keys()]);
  if (winChannels.size === 0) throw incomplete("Windows", "no architecture manifests found");
  for (const channel of [...winChannels].toSorted()) {
    const arm64 = winArm64.get(channel);
    const x64 = winX64.get(channel);
    if (arm64 === undefined || x64 === undefined) {
      throw incomplete(
        "Windows",
        `${channel} is missing its ${arm64 === undefined ? "arm64" : "x64"} manifest`,
      );
    }
    plans.push({
      platform: "win",
      primary: x64,
      secondary: arm64,
      output: `${channel}.yml`,
    });
  }

  return plans;
}

export const mergeReleaseUpdateManifestFiles = Effect.fn("mergeReleaseUpdateManifestFiles")(
  function* (releaseAssetsDirArg: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const releaseAssetsDir = path.resolve(releaseAssetsDirArg);
    const plans = planReleaseUpdateManifestMerges(yield* fs.readDirectory(releaseAssetsDir));

    yield* Effect.forEach(
      plans,
      (plan) => {
        const primary = path.join(releaseAssetsDir, plan.primary);
        const secondary = path.join(releaseAssetsDir, plan.secondary);
        const output = path.join(releaseAssetsDir, plan.output);
        return mergeUpdateManifestFiles(plan.platform, primary, secondary, output).pipe(
          Effect.andThen(
            Effect.forEach(
              [primary, secondary].filter((source) => source !== output),
              (source) => fs.remove(source),
              { discard: true },
            ),
          ),
        );
      },
      { discard: true },
    );
  },
);

export const mergeReleaseUpdateManifestsCommand = Command.make(
  "merge-release-update-manifests",
  {
    releaseAssetsDir: Argument.String("release-assets-dir").pipe(
      Argument.withDescription("Directory containing every desktop release artifact."),
    ),
  },
  ({ releaseAssetsDir }) => mergeReleaseUpdateManifestFiles(releaseAssetsDir),
).pipe(
  Command.withDescription("Require and merge complete arm64/x64 desktop updater manifest pairs."),
);

if (import.meta.main) {
  Command.run(mergeReleaseUpdateManifestsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
