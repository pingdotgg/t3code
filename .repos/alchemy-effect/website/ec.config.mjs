import { defineEcConfig } from "@astrojs/starlight/expressive-code";
import { alchemyWalnutTheme } from "./plugins/alchemy-walnut-theme.mjs";
import { capitalizedIdentifierColor } from "./plugins/capitalized-identifier-color.mjs";
import { errorAnnotations } from "./plugins/error-annotations.mjs";

export default defineEcConfig({
  themes: [alchemyWalnutTheme],
  plugins: [errorAnnotations(), capitalizedIdentifierColor()],
});
