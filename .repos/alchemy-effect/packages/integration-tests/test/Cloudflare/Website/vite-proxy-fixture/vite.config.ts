// Vite's `server.proxy` in front of the Worker under `alchemy dev`. The test
// starts a local backend and writes its URL to `backend.json` in its copy of
// this fixture.
import * as NodeFs from "node:fs";
import type { UserConfig } from "vite";

const { target } = JSON.parse(
  NodeFs.readFileSync(new URL("./backend.json", import.meta.url), "utf8"),
) as { target: string };

export default {
  server: {
    proxy: {
      "/api": target,
      "/backend-ws": { target, ws: true },
      // Decides asynchronously, after the Worker has answered the upgrade.
      "/bypass-ws": {
        target,
        ws: true,
        bypass: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return undefined;
        },
      },
    },
  },
} satisfies UserConfig;
