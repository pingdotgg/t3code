// Loads the service configuration, merging ~/.whiteboard/config.json over defaults.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

const base = `${NodeOS.homedir()}/.whiteboard`;
let overrides = {};
try {
  overrides = JSON.parse(NodeFS.readFileSync(`${base}/config.json`, "utf8"));
} catch (error) {
  if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
}
/** @type {{dataDir: string, host: string, port: number, webPort: number, chatPort: number, allowedHosts: string[], openViews: Record<string, 'board' | 'chat' | 'app'>, rightPanelMenu?: Record<string, {hidden?: boolean, key?: string}>}} */
export const config = {
  dataDir: `${base}/data`,
  host: "127.0.0.1",
  port: 6060,
  webPort: 6061,
  chatPort: 6070,
  allowedHosts: [],
  openViews: {},
  ...overrides,
};
