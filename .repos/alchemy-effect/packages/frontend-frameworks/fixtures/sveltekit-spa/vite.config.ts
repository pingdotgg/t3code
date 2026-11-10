/**
 * A REAL user-owned Vite config, exactly like a normal SvelteKit v3 project:
 * the user registers `sveltekit()` here themselves, and
 * `@alchemy.run/frontend-frameworks/sveltekit` must load this file natively and inject its
 * deploy-target adapter into THIS `sveltekit(...)` instance rather than
 * constructing a second one (the user-config principle).
 *
 * NOTE: kit v3 HARD-ERRORS if a `svelte.config.js`/`.ts` exists at the
 * project root ("svelte.config.js is no longer used") — ALL configuration,
 * including Svelte `preprocess`/`compilerOptions`, lives in this
 * `sveltekit(...)` call. The user-config proof:
 *
 * - `preprocess: [markerPreprocessor]` — rewrites the literal
 *   `__SVELTE_CONFIG_MARKER__` (rendered by the home page) to
 *   `svelte-config-loaded`; the smoke test asserts the replaced value, which
 *   only appears if this file's svelte configuration is honored.
 */
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const markerPreprocessor = {
  name: "fixture-user-preprocessor",
  markup: ({ content }: { content: string }) => {
    if (!content.includes("__SVELTE_CONFIG_MARKER__")) return undefined;
    return {
      code: content.replaceAll("__SVELTE_CONFIG_MARKER__", "svelte-config-loaded"),
    };
  },
};

export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: [markerPreprocessor],
    }),
  ],
});
