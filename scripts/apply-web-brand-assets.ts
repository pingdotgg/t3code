#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option, Path } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { resolveWebIconOverrides, type WebAssetBrand } from "./lib/brand-assets.ts";

const WEB_ASSET_BRANDS = [
  "development",
  "production",
] as const satisfies ReadonlyArray<WebAssetBrand>;

export const applyWebBrandAssets = Effect.fn("applyWebBrandAssets")(function* (
  brand: WebAssetBrand,
  targetDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

  yield* Effect.forEach(
    resolveWebIconOverrides(brand, targetDirectory),
    (override) =>
      fs.copyFile(
        path.join(repoRoot, override.sourceRelativePath),
        path.join(repoRoot, override.targetRelativePath),
      ),
    { concurrency: "unbounded" },
  );
});

export const applyWebBrandAssetsCommand = Command.make(
  "apply-web-brand-assets",
  {
    brand: Argument.choice("brand", WEB_ASSET_BRANDS).pipe(
      Argument.withDescription("Asset brand to copy into the hosted web output directory."),
    ),
    targetDirectory: Argument.string("target-directory").pipe(
      Argument.withDescription("Output directory that contains the hosted web build assets."),
      Argument.optional,
    ),
  },
  ({ brand, targetDirectory }) =>
    applyWebBrandAssets(
      brand,
      Option.getOrElse(targetDirectory, () => "apps/web/dist"),
    ),
).pipe(Command.withDescription("Copy web brand assets into a built hosted web app."));

if (import.meta.main) {
  Command.run(applyWebBrandAssetsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
