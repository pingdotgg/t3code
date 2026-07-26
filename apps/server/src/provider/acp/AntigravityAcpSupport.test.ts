import { describe, expect, it } from "vite-plus/test";

import {
  buildAntigravityAcpSpawnInput,
  parseAntigravityModelList,
  resolveAntigravityBaseModelId,
} from "./AntigravityAcpSupport.ts";
import {
  formatAntigravityModelName,
  groupAntigravityModels,
} from "../Layers/AntigravityProvider.ts";

describe("parseAntigravityModelList", () => {
  it("parses the one-slug-per-line output of `agy models`", () => {
    const models = parseAntigravityModelList(
      "gemini-3.6-flash-high\ngemini-3.1-pro-high\nclaude-sonnet-4-6\n",
    );

    expect(models).toEqual(["gemini-3.6-flash-high", "gemini-3.1-pro-high", "claude-sonnet-4-6"]);
  });

  it("drops blank lines, duplicates, and prose", () => {
    const models = parseAntigravityModelList(
      "\ngemini-3.1-pro-high\n\ngemini-3.1-pro-high\nAvailable agents:\n  gpt-oss-120b-medium  \n",
    );

    expect(models).toEqual(["gemini-3.1-pro-high", "gpt-oss-120b-medium"]);
  });
});

describe("resolveAntigravityBaseModelId", () => {
  it("resolves a bare family name to a concrete reasoning tier", () => {
    expect(resolveAntigravityBaseModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityBaseModelId("flash")).toBe("gemini-3.6-flash-medium");
  });

  it("passes through a slug that already names a tier", () => {
    expect(resolveAntigravityBaseModelId("gemini-3.6-flash-low")).toBe("gemini-3.6-flash-low");
  });

  it("falls back to the default when nothing is selected", () => {
    expect(resolveAntigravityBaseModelId(undefined)).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityBaseModelId("  ")).toBe("gemini-3.1-pro-high");
  });
});

describe("buildAntigravityAcpSpawnInput", () => {
  it("spawns this server binary's bridge subcommand rather than agy directly", () => {
    const spawn = buildAntigravityAcpSpawnInput({
      antigravitySettings: null,
      cwd: "/repo",
    });

    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args.at(-1)).toBe("agy-acp");
    expect(spawn.cwd).toBe("/repo");
  });

  it("passes per-turn configuration to the bridge through the environment", () => {
    const spawn = buildAntigravityAcpSpawnInput({
      antigravitySettings: {
        binaryPath: "/opt/agy",
        printTimeout: "30m",
        appDataDir: "/data/agy",
      } as never,
      cwd: "/repo",
      model: "gemini-3.1-pro-high",
      effort: "high",
    });

    expect(spawn.env).toMatchObject({
      T3_AGY_COMMAND: "/opt/agy",
      T3_AGY_PRINT_TIMEOUT: "30m",
      T3_AGY_APP_DATA_DIR: "/data/agy",
      T3_AGY_MODEL: "gemini-3.1-pro-high",
      T3_AGY_EFFORT: "high",
    });
  });

  it("omits unset settings so the bridge keeps its own defaults", () => {
    const spawn = buildAntigravityAcpSpawnInput({
      antigravitySettings: { binaryPath: "", printTimeout: "", appDataDir: "" } as never,
      cwd: "/repo",
    });

    expect(spawn.env).not.toHaveProperty("T3_AGY_COMMAND");
    expect(spawn.env).not.toHaveProperty("T3_AGY_PRINT_TIMEOUT");
    expect(spawn.env).not.toHaveProperty("T3_AGY_MODEL");
  });
});

describe("formatAntigravityModelName", () => {
  it("formats base model name cleanly", () => {
    expect(formatAntigravityModelName("gemini-3.1-pro-high")).toBe("Gemini 3.1 Pro");
    expect(formatAntigravityModelName("gemini-3.6-flash-low")).toBe("Gemini 3.6 Flash");
  });

  it("leaves a slug with no tier suffix alone", () => {
    expect(formatAntigravityModelName("claude-sonnet-4-6")).toBe("Claude Sonnet 4 6");
  });

  it("keeps vendor initialisms uppercase", () => {
    expect(formatAntigravityModelName("gpt-oss-120b-medium")).toBe("GPT OSS 120b");
  });
});

describe("groupAntigravityModels", () => {
  it("groups raw model slugs into base models with dynamic reasoning capabilities", () => {
    const raw = [
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "claude-sonnet-4-6",
    ];

    const grouped = groupAntigravityModels(raw);
    expect(grouped.length).toBe(2);

    const flash = grouped.find((m) => m.name === "Gemini 3.6 Flash");
    expect(flash).toBeDefined();
    expect(flash?.slug).toBe("gemini-3.6-flash-high");
    expect(flash?.capabilities?.optionDescriptors?.length).toBe(1);

    const sonnet = grouped.find((m) => m.name === "Claude Sonnet 4 6");
    expect(sonnet).toBeDefined();
    expect(sonnet?.capabilities?.optionDescriptors?.length).toBe(0);
  });
});
