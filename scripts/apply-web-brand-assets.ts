#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import {
  resolveWebAssetBrandForChannel,
  resolveWebIconOverrides,
  WEB_ASSET_CHANNELS,
  type WebAssetBrand,
} from "./lib/brand-assets.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { rebrandName } from "./lib/rebrand.ts";

const WEB_ASSET_BRANDS = [
  "development",
  "nightly",
  "production",
] as const satisfies ReadonlyArray<WebAssetBrand>;

const WebManifestJson = fromJsonStringPretty(Schema.Record(Schema.String, Schema.Unknown));
const decodeWebManifest = Schema.decodeUnknownEffect(WebManifestJson);
const encodeWebManifest = Schema.encodeEffect(WebManifestJson);

// Standalone builds name the installable web app after the fork; other builds keep the file as is.
export const applyStandaloneWebManifest = Effect.fn("applyStandaloneWebManifest")(function* (
  targetDirectory: string,
) {
  const appName = rebrandName(loadRepoEnv());
  if (!appName) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(targetDirectory, "manifest.webmanifest");
  if (!(yield* fs.exists(manifestPath))) return;
  const manifest = yield* decodeWebManifest(yield* fs.readFileString(manifestPath));
  const contents = yield* encodeWebManifest({ ...manifest, name: appName, short_name: appName });
  yield* fs.writeFileString(manifestPath, `${contents}\n`);
});

export const applyWebBrandAssets = Effect.fn("applyWebBrandAssets")(function* (
  brand: WebAssetBrand,
  targetDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

  yield* Effect.forEach(
    resolveWebIconOverrides(brand, path.resolve(repoRoot, targetDirectory)),
    (override) =>
      fs.copyFile(path.join(repoRoot, override.sourceRelativePath), override.targetRelativePath),
    { concurrency: "unbounded" },
  );
  yield* applyStandaloneWebManifest(path.resolve(repoRoot, targetDirectory));
});

export const applyWebBrandAssetsCommand = Command.make(
  "apply-web-brand-assets",
  {
    brand: Argument.Literals("brand", WEB_ASSET_BRANDS).pipe(
      Argument.withDescription("Asset brand to copy into the hosted web output directory."),
      Argument.optional,
    ),
    channel: Flag.Literals("channel", WEB_ASSET_CHANNELS).pipe(
      Flag.withDescription("Hosted release channel to map to a web asset brand."),
      Flag.optional,
    ),
    targetDirectory: Argument.String("target-directory").pipe(
      Argument.withDescription("Output directory that contains the hosted web build assets."),
      Argument.optional,
    ),
  },
  ({ brand, channel, targetDirectory }) =>
    applyWebBrandAssets(
      Option.getOrElse(brand, () =>
        Option.match(channel, {
          onNone: () => "production" as const,
          onSome: resolveWebAssetBrandForChannel,
        }),
      ),
      Option.getOrElse(targetDirectory, () => "apps/web/dist"),
    ),
).pipe(Command.withDescription("Copy web brand assets into a built hosted web app."));

if (import.meta.main) {
  Command.run(applyWebBrandAssetsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
