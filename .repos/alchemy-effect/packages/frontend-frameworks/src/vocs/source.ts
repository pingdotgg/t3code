import * as FrameworkCore from "../core/index.ts";
import * as Effect from "effect/Effect";
import vocsCloudflareTarget from "./cloudflare.ts";
import {
  makeWakuSourceProvider,
  SourceProviderError,
  type SourceProvider,
  type WakuBuildChildConfig,
  type WakuSourceOptions,
} from "../waku/source.ts";
import { make as vocsFrameworkLayer } from "./Vocs.ts";

const PROVIDER = "@alchemy.run/frontend-frameworks/vocs/source";

export interface VocsSourceOptions {
  readonly rootDir?: string;
  /** Vocs build output directory, used to exclude generated files from the input hash. */
  readonly outDir?: string;
  readonly memo?: WakuSourceOptions["memo"];
}

export const buildInChild = (config: WakuBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* FrameworkCore.Framework;
    return yield* framework.build({ root: config.rootDir });
  }).pipe(
    Effect.provide(
      vocsFrameworkLayer({
        root: config.rootDir,
        target: vocsCloudflareTarget({
          worker: {
            compatibilityDate: config.compatibilityDate,
            compatibilityFlags: config.compatibilityFlags,
          },
        }),
      }),
    ),
  );

export const makeVocsSourceProvider = (
  options: VocsSourceOptions,
): SourceProvider =>
  makeWakuSourceProvider(
    { ...options, distDir: options.outDir },
    {
      provider: PROVIDER,
      framework: "vocs",
      displayName: "Vocs",
      buildModule: import.meta.url,
      layer: ({ root, target }) =>
        vocsFrameworkLayer({
          root,
          target: vocsCloudflareTarget({ worker: target.config }),
        }),
    },
  );

const sourceModule = {
  make: (
    options: unknown,
  ): Effect.Effect<SourceProvider, SourceProviderError> => {
    if (
      options !== undefined &&
      (typeof options !== "object" || options === null)
    ) {
      return Effect.fail(
        new SourceProviderError({
          provider: PROVIDER,
          message: `Invalid options for ${PROVIDER}: expected an object, got ${typeof options}`,
        }),
      );
    }
    return Effect.succeed(
      makeVocsSourceProvider((options ?? {}) as VocsSourceOptions),
    );
  },
};

export default sourceModule;
