import path from "node:path";
import type * as vite from "vite";
import { assert, describe, expect, it } from "vitest";
import { optionsPlugin } from "../plugins/options.ts";

describe("vite worker entry resolution", () => {
  const callConfig = async (userConfig: vite.UserConfig) => {
    const plugin = optionsPlugin.vite({ compatibilityDate: "2025-07-01" });
    assert(
      typeof plugin.config === "function",
      "plugin.config is not a function",
    );
    return (await plugin.config.call({ meta: {} } as never, userConfig, {
      command: "build",
      mode: "production",
    } as vite.ConfigEnv)) as vite.UserConfig;
  };

  it("resolves a relative ssr input against the vite root", async () => {
    // The user entry is resolved with no importer, so without this a relative
    // input resolves against `process.cwd()` — the wrong base when the build
    // runs outside the project root (e.g. a monorepo infra package).
    const config = await callConfig({
      root: "/project",
      environments: {
        ssr: { build: { rollupOptions: { input: "./workers/app.ts" } } },
      },
    });
    expect(config.environments?.ssr?.build?.rollupOptions?.input).toEqual({
      app: `\0distilled:worker-entry:${path.resolve("/project", "./workers/app.ts").replaceAll("\\", "/")}`,
    });
  });

  it("leaves virtual module inputs untouched", async () => {
    const config = await callConfig({
      root: "/project",
      environments: {
        ssr: {
          build: {
            rollupOptions: { input: "virtual:react-router/server-build" },
          },
        },
      },
    });
    expect(config.environments?.ssr?.build?.rollupOptions?.input).toEqual({
      "server-build":
        "\0distilled:worker-entry:virtual:react-router/server-build",
    });
  });
});
