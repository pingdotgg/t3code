import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ViteDevServer } from "vite";
import { createServer as createViteServer } from "vite";

import webViteConfig from "../../../../web/vite.config.ts";

export interface ReplayViteServer {
  readonly appUrl: string;
  readonly restoreWorkingDirectory: () => void;
  readonly webServer: ViteDevServer;
}

function webRootPath(): string {
  return path.resolve(fileURLToPath(new URL("../../../../web", import.meta.url)));
}

export async function startReplayViteServer(wsPort: number): Promise<ReplayViteServer> {
  const previousCwd = process.cwd();
  const rootPath = webRootPath();
  let webServer: ViteDevServer | null = null;

  try {
    process.chdir(rootPath);
    webServer = await createViteServer({
      configFile: false,
      ...webViteConfig,
      root: rootPath,
      clearScreen: false,
      define: {
        ...webViteConfig.define,
        "import.meta.env.VITE_WS_URL": JSON.stringify(`ws://127.0.0.1:${wsPort}`),
      },
      server: {
        ...webViteConfig.server,
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        hmr: {
          protocol: "ws",
          host: "127.0.0.1",
        },
      },
    });
    await webServer.listen();

    const appUrl = webServer.resolvedUrls?.local[0];
    if (!appUrl) {
      throw new Error("Vite dev server did not expose a local URL.");
    }

    return {
      appUrl,
      restoreWorkingDirectory: () => {
        process.chdir(previousCwd);
      },
      webServer,
    };
  } catch (error) {
    await webServer?.close().catch(() => undefined);
    process.chdir(previousCwd);
    throw error;
  }
}
