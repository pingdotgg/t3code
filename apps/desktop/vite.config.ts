import { defineConfig } from "vite-plus";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  pack: [
    {
      ...shared,
      entry: ["src/main.ts"],
      clean: true,
      noExternal: (id) => id.startsWith("@t3tools/"),
    },
    {
      ...shared,
      entry: ["src/preload.ts"],
    },
  ],
});
