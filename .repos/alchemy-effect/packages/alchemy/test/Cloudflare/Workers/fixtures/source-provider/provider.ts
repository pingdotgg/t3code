import type * as Bundle from "@/Bundle/Bundle.ts";
import type {
  SourceProvider,
  WorkerSourceModule,
} from "@/Cloudflare/Workers/Source.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as crypto from "node:crypto";

/**
 * Minimal external source-provider fixture for the loadSource unit
 * tests: builds a one-module bundle whose content embeds the
 * descriptor's `marker` option.
 */
const make: WorkerSourceModule["make"] = (options) =>
  Effect.sync((): SourceProvider => {
    const marker = (options as { marker?: string } | undefined)?.marker ?? "";
    const content = `export default { fetch: () => new Response(${JSON.stringify(marker)}) };`;
    const bundle = Effect.sync((): Bundle.BundleOutput => {
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      return {
        files: [{ path: "main.js", content, hash }],
        hash,
      };
    });
    return {
      ownsAssets: false,
      build: () =>
        bundle.pipe(
          Effect.map((output) => ({
            bundle: output,
            assets: undefined,
            hash: {
              bundle: output.hash,
              assets: undefined,
              input: undefined,
              additionalWorkspaces: undefined,
            },
          })),
        ),
      hash: () =>
        bundle.pipe(Effect.map((output) => ({ bundle: output.hash }))),
      dev: () =>
        bundle.pipe(
          Effect.map((output) => ({
            mode: "bundle" as const,
            bundles: Stream.make({
              _tag: "Success",
              output,
            } as Bundle.BundleWatchEvent),
          })),
        ),
    };
  });

export default { make } satisfies WorkerSourceModule;
