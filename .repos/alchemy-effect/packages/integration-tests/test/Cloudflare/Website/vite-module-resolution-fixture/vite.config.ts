// Mirrors `@cloudflare/vite-plugin`'s `playground/module-resolution`: a user
// alias, and an optimizeDeps-excluded package importing a virtual module.
// Also `playground/virtual-modules`: a Worker imports a plugin's virtual
// module. The `@playground/*` packages are installed into `node_modules` by the test.
import { resolve } from "node:path";
// @ts-expect-error Missing types
import testDepPlugin from "@playground/module-resolution-excludes/plugin";

export default {
  resolve: {
    alias: {
      "@alias/test": resolve(import.meta.dirname, "./src/aliasing.ts"),
    },
  },
  environments: {
    ssr: {
      optimizeDeps: {
        exclude: ["@playground/module-resolution-excludes"],
      },
    },
  },
  plugins: [
    {
      name: "virtual-module-plugin",
      resolveId(id: string) {
        if (id === "virtual:module") {
          return `\0virtual:module`;
        }
      },
      load(id: string) {
        if (id === "\0virtual:module") {
          return `export default 'virtual module'`;
        }
      },
    },
    testDepPlugin(),
  ],
};
