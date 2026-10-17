import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(new URL("../metro.config.js", import.meta.url));
const configPath = require.resolve("./metro.config.js");
const projectRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

it("invalidates Expo's transform cache when the installed Worklets version changes", async () => {
  const workletsPackage = require("react-native-worklets/package.json") as { version: string };
  const originalVersion = workletsPackage.version;
  const { unstable_transformerPath } = require("expo/metro-config") as {
    unstable_transformerPath: string;
  };
  const worker = require(unstable_transformerPath) as {
    getCacheKey: (config: object, options: { projectRoot: string }) => string;
  };
  const loadConfig = async (version: string) => {
    workletsPackage.version = version;
    delete require.cache[configPath];
    return (await require(configPath)) as {
      transformer: { workletsVersion: string | null };
    };
  };

  try {
    const before = await loadConfig("0.10.1");
    const beforeKey = worker.getCacheKey(before.transformer, { projectRoot });
    const after = await loadConfig("0.11.4");
    const afterKey = worker.getCacheKey(after.transformer, { projectRoot });

    expect(afterKey).not.toBe(beforeKey);
    expect(before.transformer.workletsVersion).toBe("0.10.1");
    expect(after.transformer.workletsVersion).toBe("0.11.4");
    expect(worker.getCacheKey(after.transformer, { projectRoot })).toBe(afterKey);
  } finally {
    workletsPackage.version = originalVersion;
    delete require.cache[configPath];
  }
});
