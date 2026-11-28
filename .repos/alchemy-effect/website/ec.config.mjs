import { defineEcConfig } from "@astrojs/starlight/expressive-code";
import {
  alchemyWalnutTheme,
  capitalizedIdentifierColor,
  errorAnnotations,
} from "./plugins/expresssive-code.ts";
import { previewInstallUrls } from "./plugins/preview-install.ts";

export default defineEcConfig({
  themes: [alchemyWalnutTheme],
  plugins: [errorAnnotations(), capitalizedIdentifierColor(), previewInstallUrls()],
});
