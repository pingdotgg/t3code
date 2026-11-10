import assert from "node:assert";
import { defineConfig } from "vite";

// The playground's plugin: resolving a Node.js built-in through the Worker
// environment's plugin container yields its external id.
export default defineConfig({
  plugins: [
    {
      name: "test-plugin",
      async configureServer(viteDevServer) {
        const workerEnvironment = viteDevServer.environments.ssr;
        assert(workerEnvironment);

        const resolved = await workerEnvironment.pluginContainer.resolveId("node:dns");

        if (resolved) {
          workerEnvironment.logger.info(`__${resolved.id}__`);
        }
      },
    },
  ],
});
