// Mirrors `@cloudflare/vite-plugin`'s `playground/child-environment`: the
// Worker (`parent` environment) imports a module built by its `child`
// environment, with the user's own `buildApp` ordering the builds.
import assert from "node:assert";
import * as path from "node:path";
import type { ViteBuilder } from "vite";

export default {
  environments: {
    child: {
      build: {
        rollupOptions: {
          input: path.resolve(import.meta.dirname, "src/child-environment-module.ts"),
        },
      },
    },
  },
  builder: {
    async buildApp(builder: ViteBuilder) {
      const parentEnvironment = builder.environments.parent;
      const childEnvironment = builder.environments.child;

      assert(parentEnvironment, `No "parent" environment`);
      assert(childEnvironment, `No "child" environment`);

      await builder.build(parentEnvironment);
      await builder.build(childEnvironment);
    },
  },
  plugins: [
    {
      name: "virtual-module-plugin",
      resolveId(source: string) {
        if (source === "virtual:environment-name") {
          return "\0virtual:environment-name";
        }
      },
      load(this: { environment: { name: string } }, id: string) {
        if (id === "\0virtual:environment-name") {
          return `export function getEnvironmentName() { return ${JSON.stringify(this.environment.name)} }`;
        }
      },
    },
  ],
};
