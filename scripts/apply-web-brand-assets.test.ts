import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import type { WebAssetBrand } from "./lib/brand-assets.ts";

const WEB_ICON_FILENAMES = [
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
  "icon-192.png",
  "icon-512.png",
];

const WEB_ASSET_BRANDS: ReadonlyArray<WebAssetBrand> = ["development", "nightly", "production"];

// Firefox for Android only offers an installable web app with an any/maskable icon of at least 192px.
const MIN_INSTALLABLE_ICON_SIZE = 192;

const decodeWebManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      icons: Schema.Array(
        Schema.Struct({
          src: Schema.String,
          sizes: Schema.String,
          purpose: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

const declaredSizes = (sizes: string) =>
  sizes.split(/\s+/).map((size) => size.split("x").map(Number));

const pngDimensions = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
};

it.layer(NodeServices.layer)("apply-web-brand-assets", (it) => {
  it.effect("copies the icons into an absolute target directory as given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const targetDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "apply-web-brand-assets-",
      });

      yield* applyWebBrandAssets("production", targetDirectory);

      assert.deepStrictEqual(
        (yield* fs.readDirectory(targetDirectory)).toSorted(),
        WEB_ICON_FILENAMES,
      );
    }),
  );

  it.effect("resolves an empty target directory to the repo root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const destinations = WEB_ICON_FILENAMES.map((filename) => path.join(repoRoot, filename));
      // readDirectory does not follow symlinks, so a dangling link counts as an existing entry.
      // Names are lowercased so a case-insensitive filesystem cannot hide a differently cased file.
      const existingEntries = new Set(
        (yield* fs.readDirectory(repoRoot)).map((entry) => entry.toLowerCase()),
      );
      for (const destination of destinations) {
        assert.isFalse(
          existingEntries.has(path.basename(destination)),
          `${destination} already exists`,
        );
      }
      yield* Effect.addFinalizer(() =>
        Effect.forEach(destinations, (destination) => fs.remove(destination, { force: true })).pipe(
          Effect.orDie,
        ),
      );

      yield* applyWebBrandAssets("production", "");

      for (const destination of destinations) {
        assert.isTrue(yield* fs.exists(destination));
      }
    }),
  );

  it.effect("ships an installable manifest icon in every brand", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const { icons } = decodeWebManifest(
        yield* fs.readFileString(path.join(repoRoot, "apps/web/public/manifest.webmanifest")),
      );

      assert.isTrue(
        icons.some(
          (icon) =>
            (icon.purpose ?? "any").split(/\s+/).some((p) => p === "any" || p === "maskable") &&
            declaredSizes(icon.sizes).some(
              ([width = 0, height = 0]) => Math.min(width, height) >= MIN_INSTALLABLE_ICON_SIZE,
            ),
        ),
        `manifest declares no any/maskable icon of at least ${MIN_INSTALLABLE_ICON_SIZE}px: ${JSON.stringify(icons)}`,
      );

      for (const brand of WEB_ASSET_BRANDS) {
        const targetDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "apply-web-brand-assets-",
        });
        yield* applyWebBrandAssets(brand, targetDirectory);

        for (const icon of icons) {
          const iconPath = path.join(targetDirectory, icon.src);
          assert.isTrue(yield* fs.exists(iconPath), `${brand} does not supply ${icon.src}`);
          assert.deepInclude(
            declaredSizes(icon.sizes),
            pngDimensions(yield* fs.readFile(iconPath)),
            `${brand} ${icon.src} does not match its declared sizes ${icon.sizes}`,
          );
        }
      }
    }),
  );
});
