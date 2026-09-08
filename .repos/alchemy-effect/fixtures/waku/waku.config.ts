import type { Plugin } from "vite";
import { defineConfig } from "waku/config";

/**
 * Real user config file, loaded NATIVELY by the integration (the same
 * `vite.runnerImport("/waku.config")` semantics as waku's own CLI — see
 * packages/frontend-frameworks/src/waku/Waku.ts `loadUserConfigFile`). Both settings here are
 * user-observable and only work if this file is honored:
 *
 * - `rscBase` moves waku's RSC endpoint/payload base from the default `RSC`
 *   to `custom-rsc` (asserted against the SSG payload path in the smoke
 *   test).
 * - the user vite plugin serves a virtual module imported by
 *   `src/pages/config-marker.tsx` — if the file were replaced instead of
 *   merged, the import would not resolve and build/dev would fail outright.
 */

export const USER_CONFIG_MARKER = "hello-from-waku-config";

const VIRTUAL_ID = "virtual:fixtures-waku/user-config-marker";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

const userConfigMarkerPlugin = (): Plugin => ({
  name: "fixtures-waku:user-config-marker",
  resolveId(id) {
    if (id === VIRTUAL_ID) {
      return RESOLVED_VIRTUAL_ID;
    }
    return;
  },
  load(id) {
    if (id === RESOLVED_VIRTUAL_ID) {
      return `export const marker = ${JSON.stringify(USER_CONFIG_MARKER)};`;
    }
    return;
  },
});

export default defineConfig({
  rscBase: "custom-rsc",
  vite: {
    plugins: [userConfigMarkerPlugin()],
  },
});
