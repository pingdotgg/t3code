import type { Config } from "@react-router/dev/config";

/**
 * Framework-mode config. Everything here is the default — it is spelled out
 * so the fixture pins the on-disk layout the AWS integration reads:
 * `build/client` for assets and `build/server/index.js` for the SSR bundle.
 */
export default {
  ssr: true,
  appDirectory: "app",
  buildDirectory: "build",
  serverBuildFile: "index.js",
} satisfies Config;
