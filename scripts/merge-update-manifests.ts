import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
  type UpdateManifest,
} from "./lib/update-manifest.ts";

export type UpdateManifestPlatform = "mac" | "win";

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

function parseArgs(args: ReadonlyArray<string>): {
  platform: UpdateManifestPlatform;
  primaryPath: string;
  secondaryPath: string;
  outputPath: string;
} {
  const [platformFlag, platformValue, primaryPathArg, secondaryPathArg, outputPathArg] = args;
  if (platformFlag !== "--platform" || (platformValue !== "mac" && platformValue !== "win")) {
    throw new Error(
      "Usage: node scripts/merge-update-manifests.ts --platform <mac|win> <primary-path> <secondary-path> [output-path]",
    );
  }
  if (!primaryPathArg || !secondaryPathArg) {
    throw new Error(
      "Usage: node scripts/merge-update-manifests.ts --platform <mac|win> <primary-path> <secondary-path> [output-path]",
    );
  }

  const primaryPath = resolve(primaryPathArg);
  const secondaryPath = resolve(secondaryPathArg);
  const outputPath = resolve(outputPathArg ?? primaryPathArg);

  return {
    platform: platformValue,
    primaryPath,
    secondaryPath,
    outputPath,
  };
}

function main(args: ReadonlyArray<string>): void {
  const { platform, primaryPath, secondaryPath, outputPath } = parseArgs(args);
  const primaryManifest = parsePlatformUpdateManifest(
    platform,
    readFileSync(primaryPath, "utf8"),
    primaryPath,
  );
  const secondaryManifest = parsePlatformUpdateManifest(
    platform,
    readFileSync(secondaryPath, "utf8"),
    secondaryPath,
  );
  const merged = mergePlatformUpdateManifests(platform, primaryManifest, secondaryManifest);
  writeFileSync(outputPath, serializePlatformUpdateManifest(platform, merged));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
