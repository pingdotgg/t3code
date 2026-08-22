import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ACP_FEATURED_AGENTS,
  AcpRegistryIndex,
  defaultLaunchForFeaturedAgent,
  featuredAgentById,
  formatAcpLaunchArgs,
  parseAcpLaunchArgs,
} from "./acpRegistry.ts";

const decodeIndex = Schema.decodeUnknownSync(AcpRegistryIndex);

describe("ACP featured catalog", () => {
  it("includes Gemini, Copilot, Pi, and a custom ACP slot", () => {
    expect(ACP_FEATURED_AGENTS.map((agent) => agent.id)).toEqual(
      expect.arrayContaining(["gemini", "github-copilot-cli", "pi-acp", "custom"]),
    );
  });

  it("resolves featured launch specs without downloading binaries", () => {
    expect(defaultLaunchForFeaturedAgent(featuredAgentById("gemini")!)).toEqual({
      command: "gemini",
      args: ["--acp"],
    });
    expect(defaultLaunchForFeaturedAgent(featuredAgentById("pi-acp")!)).toEqual({
      command: "pi-acp",
      args: [],
    });
    expect(defaultLaunchForFeaturedAgent(featuredAgentById("custom")!)).toBeUndefined();
  });
});

describe("parseAcpLaunchArgs", () => {
  it("splits quoted arguments", () => {
    expect(parseAcpLaunchArgs(`--acp --model "gemini 3"`)).toEqual([
      "--acp",
      "--model",
      "gemini 3",
    ]);
    expect(formatAcpLaunchArgs(["--acp", "--model", "gemini 3"])).toBe('--acp --model "gemini 3"');
  });

  it("treats empty input as no args", () => {
    expect(parseAcpLaunchArgs("")).toEqual([]);
    expect(parseAcpLaunchArgs("   ")).toEqual([]);
  });
});

describe("AcpRegistryIndex", () => {
  it("decodes the official registry shape", () => {
    const decoded = decodeIndex({
      version: "1.0.0",
      agents: [
        {
          id: "gemini",
          name: "Gemini CLI",
          version: "0.54.4",
          description: "Google's official CLI for Gemini",
          distribution: {
            npx: { package: "@google/gemini-cli@0.54.4", args: ["--acp"] },
          },
        },
      ],
    });

    expect(decoded.agents[0]?.id).toBe("gemini");
    expect(decoded.agents[0]?.distribution.npx?.package).toBe("@google/gemini-cli@0.54.4");
  });
});
