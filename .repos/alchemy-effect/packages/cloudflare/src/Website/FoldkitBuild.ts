import { BundleError } from "alchemy/Bundle/Bundle";
import * as Schema from "effect/Schema";
import type { Plugin } from "vite";
import type { AssetsConfig } from "../Workers/Assets.ts";

/** The versioned manifest returned by Foldkit's completed-build API. */
export const FoldkitBuildManifest = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  client: Schema.String,
  server: Schema.String,
  serverEntry: Schema.String,
  prerendered: Schema.Array(Schema.String),
});

export type FoldkitBuildManifest = typeof FoldkitBuildManifest.Type;

/** Validate the app's plugin result without loading a second Foldkit copy. */
export const FoldkitBuildMetadata = Schema.Struct({
  root: Schema.String,
  clientDirectory: Schema.String,
  serverDirectory: Schema.String,
  serverEntry: Schema.String,
  manifest: FoldkitBuildManifest,
});

export type FoldkitBuildMetadata = typeof FoldkitBuildMetadata.Type;

/** Prepare before building; call the reader only after buildApp succeeds. */
export const foldkitBuildMetadataReader = (
  plugins: ReadonlyArray<Pick<Plugin, "name" | "api">>,
  main: string | undefined,
): (() => FoldkitBuildMetadata) | undefined => {
  const plugin = plugins.find((plugin) => plugin.name === "foldkit:build");
  if (plugin === undefined) return undefined;
  if (main !== undefined) {
    throw BundleError.make({
      message:
        "Foldkit ssr.build generates the Worker fetch handler and cannot be combined with main. Remove main or disable ssr.build for a custom Worker entry.",
    });
  }
  if (typeof plugin.api?.getBuildMetadata !== "function") {
    throw BundleError.make({
      message:
        "Foldkit's build plugin does not expose getBuildMetadata(). Upgrade @foldkit/vite-plugin to 0.25.0 or newer.",
    });
  }
  // oxlint-disable-next-line effecttsgo/schema-sync -- read inside Vite's build callback; a throw is caught by its tryPromise
  return () => Schema.decodeUnknownSync(FoldkitBuildMetadata)(plugin.api.getBuildMetadata());
};

/**
 * Client-only builds need SPA fallback. Server builds contain only generated
 * pages in the client directory, so normal asset lookup serves prerendered
 * routes and misses reach Foldkit's generated document handler.
 * Explicit resource asset settings override this default.
 */
export const foldkitAssetsFromManifest = (
  manifest: FoldkitBuildManifest | undefined,
): AssetsConfig | undefined =>
  manifest === undefined ? { notFoundHandling: "single-page-application" } : undefined;
