import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const captureDir = path.resolve(import.meta.dirname, "..", "out", "capture");

/** Tell the page when intro.json or a scene.json is rebuilt, so it reloads the data in place. */
const captureData = (): Plugin => ({
  name: "prezzy-capture-data",
  configureServer(server) {
    server.watcher.add(captureDir);
    server.watcher.on("change", (file) => {
      if (
        file.startsWith(captureDir) &&
        file.endsWith(".json") &&
        !file.endsWith("diagnostics.json")
      ) {
        server.ws.send({ type: "custom", event: "prezzy:data", data: { file } });
      }
    });
  },
});

export default defineConfig({
  root: import.meta.dirname,
  // Captures (scene.json, terminal clips, screenshots, intro.json) are served
  // at the root, where Remotion's staticFile() looks for them.
  publicDir: captureDir,
  plugins: [react(), captureData()],
  server: { port: 5199, fs: { allow: [path.resolve(import.meta.dirname, "..", "..", "..")] } },
});
