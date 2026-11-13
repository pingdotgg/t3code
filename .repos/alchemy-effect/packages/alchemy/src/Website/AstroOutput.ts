import * as Effect from "effect/Effect";
import { initialCwd } from "../Util/Node.ts";

export interface AstroOutputProps {
  /** Project root, relative to the initial working directory. */
  readonly rootDir?: string | undefined;
  /** Alternate astro config file, relative to {@link rootDir}. */
  readonly config?: string | undefined;
  /** The composite's `astro.output` prop. */
  readonly output?: "server" | "static" | undefined;
}

/**
 * Resolves the Astro `output` a website composite deploys: the
 * `astro.output` prop, else the `output` declared in the project's
 * `astro.config.*`, else `"server"`. Composites decide at plan time whether
 * a site is assets-only, so the config file is read here rather than left
 * to the build.
 *
 * `@alchemy.run/frontend-frameworks` is an optional peer dependency, so it
 * is imported lazily. When it is missing or the config cannot be loaded the
 * site falls back to `"server"` (the build reports the real error).
 */
export const resolveAstroOutput = Effect.fn("Website.resolveAstroOutput")(function* (
  props: AstroOutputProps,
) {
  if (props.output !== undefined) return props.output;
  const declared = yield* Effect.tryPromise(
    () => import("@alchemy.run/frontend-frameworks/astro/config"),
  ).pipe(
    Effect.flatMap((astro) =>
      astro.readConfigOutput({ cwd: initialCwd, rootDir: props.rootDir, config: props.config }),
    ),
    Effect.catch((error) =>
      Effect.logWarning(
        `Could not read \`output\` from the Astro config in "${props.rootDir ?? "."}"; deploying with "server"`,
        error,
      ).pipe(Effect.as(undefined)),
    ),
  );
  return declared ?? "server";
});

export interface AstroSettings {
  /** The resolved `output` (see {@link resolveAstroOutput}). */
  readonly output: "server" | "static";
  /**
   * Whether the Astro config routes caching through the Cloudflare cache
   * provider (`cacheCloudflare()`), so the Worker needs Workers Cache on.
   */
  readonly workerCache: boolean;
}

/**
 * Resolves the Astro settings a Cloudflare composite deploys from one read
 * of the project's `astro.config.*`: the `output` (as
 * {@link resolveAstroOutput}) and whether the config uses the Cloudflare
 * cache provider. When the config cannot be loaded the site falls back to
 * `"server"` without Workers Cache (the build reports the real error).
 */
export const resolveAstroSettings = Effect.fn("Website.resolveAstroSettings")(function* (
  props: AstroOutputProps,
) {
  const declared = yield* Effect.tryPromise(
    () => import("@alchemy.run/frontend-frameworks/astro/config"),
  ).pipe(
    Effect.flatMap((astro) =>
      astro.readConfigSettings({ cwd: initialCwd, rootDir: props.rootDir, config: props.config }),
    ),
    Effect.catch((error) =>
      Effect.logWarning(
        `Could not read the Astro config in "${props.rootDir ?? "."}"; deploying with ${
          props.output === undefined ? '"server"' : `"${props.output}"`
        } and without Workers Cache`,
        error,
      ).pipe(Effect.as(undefined)),
    ),
  );
  return {
    output: props.output ?? declared?.output ?? "server",
    workerCache: declared?.workerCache ?? false,
  } satisfies AstroSettings;
});
