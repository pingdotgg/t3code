import { defineEcConfig } from "@astrojs/starlight/expressive-code";
import ecTwoSlash from "expressive-code-twoslash";
import { alchemyWalnutTheme } from "./plugins/alchemy-walnut-theme.mjs";
import { capitalizedIdentifierColor } from "./plugins/capitalized-identifier-color.mjs";
import {
  twoslashDiffPrefixAnnotate,
  twoslashDiffPrefixStrip,
} from "./plugins/twoslash-diff-prefix.mjs";
import { twoslashErrorTransform } from "./plugins/twoslash-error-transform.mjs";

const baseUrl = new URL("../", import.meta.url).pathname;

export default defineEcConfig({
  themes: [alchemyWalnutTheme],
  plugins: [
    twoslashDiffPrefixStrip(),
    ecTwoSlash({
      instanceConfigs: {
        twoslash: {
          explicitTrigger: true,
          languages: ["ts", "tsx", "typescript"],
        },
      },
      twoslashOptions: {
        customTags: ["error", "warn", "log", "annotate"],
        compilerOptions: {
          moduleResolution: /** @type {any} */ (100), // Bundler
          module: /** @type {any} */ (99), // ESNext
          target: /** @type {any} */ (9), // ES2022
          strict: true,
          types: ["bun"],
          baseUrl,
          paths: {
            alchemy: ["./packages/alchemy/src/index.ts"],
            "alchemy/*": ["./packages/alchemy/src/*"],
          },
        },
      },
    }),
    twoslashDiffPrefixAnnotate(),
    twoslashErrorTransform(),
    capitalizedIdentifierColor(),
  ],
});
