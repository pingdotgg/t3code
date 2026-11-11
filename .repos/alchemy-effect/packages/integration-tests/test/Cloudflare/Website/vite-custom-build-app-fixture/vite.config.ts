// Mirrors `@cloudflare/vite-plugin`'s `playground/custom-build-app`: the
// user's `buildApp` drives the builds (the Worker environment twice, as some
// plugins do). Each step is also appended to `build-app.log` for the test.
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ViteBuilder } from "vite";

const record = (step: string) =>
  fs.appendFileSync(path.join(import.meta.dirname, "build-app.log"), `${step}\n`);

export default {
  builder: {
    async buildApp(builder: ViteBuilder) {
      const workerEnvironment = builder.environments.ssr;
      const clientEnvironment = builder.environments.client;

      assert(workerEnvironment, `No "ssr" environment`);
      assert(clientEnvironment, `No "client" environment`);

      builder.config.logger.info("__before-build__");
      record("__before-build__");
      await builder.build(workerEnvironment);
      // Some plugins build the Worker environment twice so we do that here to test this scenario
      await builder.build(workerEnvironment);
      builder.config.logger.info("__after-build__");
      record("__after-build__");

      await builder.build(clientEnvironment);
    },
  },
};
