import { defineEcConfig } from "@astrojs/starlight/expressive-code";
import {
  alchemyWalnutTheme,
  capitalizedIdentifierColor,
  errorAnnotations,
} from "./plugins/expresssive-code.ts";

export default defineEcConfig({
  themes: [alchemyWalnutTheme],
  plugins: [errorAnnotations(), capitalizedIdentifierColor()],
});
