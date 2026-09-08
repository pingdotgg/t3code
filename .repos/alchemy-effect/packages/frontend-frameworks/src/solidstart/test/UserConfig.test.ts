import { describe, expect, it } from "vitest";
import {
  findPresetConflict,
  hasForeignNitroPlugin,
  isSamePreset,
  markInjectedPlugins,
  NITRO_PLUGIN_NAME,
  normalizePresetName,
  resolveNitroConfig,
  resolveNitroOutputDirs,
  type NitroConfigSlice,
} from "../UserConfig.ts";

const resolve = (...segments: Array<string>): string =>
  segments.reduce((acc, segment) =>
    segment.startsWith("/") ? segment : `${acc}/${segment}`,
  );

describe("normalizePresetName / isSamePreset", () => {
  it("treats kebab, snake, and camel spellings as the same preset", () => {
    expect(normalizePresetName("awsLambda")).toBe("aws-lambda");
    expect(normalizePresetName("aws_lambda")).toBe("aws-lambda");
    expect(isSamePreset("aws-lambda", "awsLambda")).toBe(true);
    expect(isSamePreset("aws-lambda", "node-server")).toBe(false);
  });
});

describe("findPresetConflict", () => {
  it("returns undefined when no preset is given or it matches the target", () => {
    expect(findPresetConflict(undefined, "aws-lambda")).toBeUndefined();
    expect(findPresetConflict({}, "aws-lambda")).toBeUndefined();
    expect(
      findPresetConflict({ preset: "aws_lambda" }, "aws-lambda"),
    ).toBeUndefined();
  });

  it("surfaces a foreign preset so the build can fail actionably", () => {
    expect(findPresetConflict({ preset: "netlify" }, "aws-lambda")).toBe(
      "netlify",
    );
  });
});

describe("resolveNitroConfig", () => {
  it("enforces the target's preset and rootDir over the caller's overrides", () => {
    const config = resolveNitroConfig({
      preset: "aws-lambda",
      rootDir: "/project",
      nitro: {
        preset: "node-server",
        rootDir: "/elsewhere",
        prerender: { crawlLinks: true },
      },
    });
    expect(config.preset).toBe("aws-lambda");
    expect(config.rootDir).toBe("/project");
    expect(config.buildDir).toBe("/project/.nitro");
    // Everything the integration does not own is preserved.
    expect(config["prerender"]).toEqual({ crawlLinks: true });
  });

  it("runs the target's configure pass after the preset is enforced", () => {
    const config = resolveNitroConfig({
      preset: "aws-lambda",
      rootDir: "/project",
      nitro: { awsLambda: { foo: 1 } },
      configure: (nitroConfig: NitroConfigSlice) => {
        nitroConfig.awsLambda = {
          ...(nitroConfig.awsLambda as Record<string, unknown>),
          streaming: true,
        };
      },
    });
    expect(config.awsLambda).toEqual({ foo: 1, streaming: true });
  });
});

describe("resolveNitroOutputDirs", () => {
  it("mirrors nitro's defaults", () => {
    expect(resolveNitroOutputDirs({}, "/project", resolve)).toEqual({
      dir: "/project/.output",
      serverDir: "/project/.output/server",
      publicDir: "/project/.output/public",
    });
  });

  it("honors an output override on the nitro config", () => {
    expect(
      resolveNitroOutputDirs(
        { output: { dir: "build", serverDir: "fn", publicDir: "static" } },
        "/project",
        resolve,
      ),
    ).toEqual({
      dir: "/project/build",
      serverDir: "/project/build/fn",
      publicDir: "/project/build/static",
    });
  });
});

describe("hasForeignNitroPlugin", () => {
  it("ignores the plugin instances this integration created", () => {
    const injected = markInjectedPlugins([
      { name: "alchemy:solidstart-nitro-conflict" },
      [{ name: NITRO_PLUGIN_NAME }, false],
    ]);
    expect(hasForeignNitroPlugin(injected)).toBe(false);
  });

  it("detects a project-registered nitro plugin, however nested", () => {
    const injected = markInjectedPlugins([{ name: NITRO_PLUGIN_NAME }]);
    expect(
      hasForeignNitroPlugin([
        [{ name: "solid-start:config" }, [{ name: NITRO_PLUGIN_NAME }]],
        injected,
      ]),
    ).toBe(true);
  });

  it("tolerates falsy and non-plugin entries", () => {
    expect(hasForeignNitroPlugin([false, null, undefined, "x"])).toBe(false);
    expect(hasForeignNitroPlugin(undefined)).toBe(false);
  });
});
