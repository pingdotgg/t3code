import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        // Workspace packages resolve to their TypeScript source. Electron's
        // packaged Node runtime cannot load that source directly (Node's type
        // stripping rejects it), so inline every workspace runtime imported by
        // the main process. Keep native addons external so electron-builder
        // can place their platform-specific binaries beside the bundle.
        alwaysBundle: (id) =>
          id === "@t3tools/jarvis-native-voice" || id.startsWith("@t3tools/jarvis-client-runtime"),
        neverBundle: ["electron", "node-cpal", "sherpa-onnx-node", "uiohook-napi"],
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["../../packages/jarvis-native-voice/src/pocket-worker.ts"],
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preload.ts"],
      deps: {
        neverBundle: ["electron"],
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/relay-preload.ts"],
      deps: {
        neverBundle: ["electron"],
      },
    },
  ],
});
