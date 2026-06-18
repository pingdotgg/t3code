import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/extension.ts"],
  outDir: "dist",
  clean: false,
  platform: "node",
  target: "node20",
  external: ["vscode"],
  noExternal: (id) => id.startsWith("@t3tools/"),
  sourcemap: true,
});
