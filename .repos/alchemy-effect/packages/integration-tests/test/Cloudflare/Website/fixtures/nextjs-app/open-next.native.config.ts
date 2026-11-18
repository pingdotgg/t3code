import { defineCloudflareConfig, type OpenNextConfig } from "@opennextjs/cloudflare";
import staticAssetsCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

const handlerPaths = ["/api/config"];

export const buildCommand =
  "npx next build && node -e \"require('node:fs').writeFileSync('../native-build-marker', 'native');\"";

const config: OpenNextConfig = {
  ...defineCloudflareConfig({ incrementalCache: staticAssetsCache }),
  appPath: "native-output",
  buildOutputPath: "native-output",
  packageJsonPath: "native-output/package.json",
  buildCommand,
  dangerous: {
    headersAndCookiesPriority: (event) =>
      handlerPaths.some((prefix) => event.rawPath.startsWith(prefix)) ? "handler" : "middleware",
  },
};

export default config;
