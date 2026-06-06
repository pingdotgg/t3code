import { defineConfig } from "vite";

export default defineConfig({
  esbuild: {
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  },
  build: {
    emptyOutDir: true,
    lib: {
      entry: "src/client/index.tsx",
      name: "T3VoiceInputPluginClient",
      formats: ["iife"],
      fileName: () => "client.iife.js",
    },
    minify: false,
    sourcemap: true,
  },
});
