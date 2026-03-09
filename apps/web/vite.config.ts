import { formatHostForUrl, isIpAddressHost, isLoopbackHost, isWildcardHost, normalizeHost } from "@t3tools/shared/host";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

const port = Number(process.env.PORT ?? 5733);
const bindHost = process.env.T3CODE_HOST ? normalizeHost(process.env.T3CODE_HOST) : "localhost";
const remoteBindEnabled = !isLoopbackHost(bindHost);
const configuredDevUrl = process.env.VITE_DEV_SERVER_URL;
const devServerUrl = configuredDevUrl ? new URL(configuredDevUrl) : undefined;
const explicitPublicHost = devServerUrl?.hostname;
const publicHmrHost =
  explicitPublicHost && (!isLoopbackHost(explicitPublicHost) || !isWildcardHost(bindHost))
    ? explicitPublicHost
    : !isWildcardHost(bindHost)
      ? formatHostForUrl(bindHost)
      : undefined;
const allowedHosts = (() => {
  if (remoteBindEnabled) {
    return true;
  }

  const candidate = publicHmrHost ?? (!isWildcardHost(bindHost) ? bindHost : undefined);
  if (!candidate || isLoopbackHost(candidate) || isIpAddressHost(candidate)) {
    return undefined;
  }
  return [normalizeHost(candidate)];
})();

export default defineConfig({
  plugins: [
    tanstackRouter(),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: ["@pierre/diffs", "@pierre/diffs/react", "@pierre/diffs/worker/worker.js"],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
  },
  experimental: {
    enableNativePlugin: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host: bindHost,
    port,
    strictPort: true,
    ...(allowedHosts ? { allowedHosts } : {}),
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      ...(publicHmrHost ? { host: publicHmrHost } : {}),
      clientPort: Number(devServerUrl?.port ?? port),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
