import * as Config from "effect/Config";

declare const __T3CODE_BUILD_STANDALONE__: boolean | undefined;

/**
 * A standalone server reaches no T3-operated service unless configured to. Builds with
 * `T3CODE_STANDALONE=1` bake this in, so the desktop's bundled server needs no shell setup.
 */
export const standaloneConfig = Config.Boolean("T3CODE_STANDALONE").pipe(
  Config.withDefault(
    typeof __T3CODE_BUILD_STANDALONE__ !== "undefined" && __T3CODE_BUILD_STANDALONE__,
  ),
);
