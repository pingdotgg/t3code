import { describe, expect, it } from "vite-plus/test";

import {
  ACP_LOCAL_AGENT_PRESETS,
  isConfiguredAcpLocalAgent,
  matchAcpLocalAgentPresets,
} from "./acpLocalAgents";

const ohMyPi = ACP_LOCAL_AGENT_PRESETS[0]!;

it("ships the product logo for the preset", () => {
  expect(ohMyPi.icon?.viewBox).toBe("0 0 64 64");
  expect(ohMyPi.icon?.paths[0]?.gradient?.stops.map((stop) => stop.color)).toEqual([
    "#ed4abf",
    "#9b4dff",
    "#5ad8e6",
  ]);
});

describe("matchAcpLocalAgentPresets", () => {
  it("matches the name, id, executable, and keywords without case sensitivity", () => {
    for (const query of ["Oh My Pi", "oh-my-pi", "omp", "OMP", "pi"]) {
      expect(matchAcpLocalAgentPresets(query)).toEqual([ohMyPi]);
    }
  });

  it("shows nothing for an empty query", () => {
    expect(matchAcpLocalAgentPresets("")).toEqual([]);
    expect(matchAcpLocalAgentPresets("   ")).toEqual([]);
  });

  it("shows nothing for an unrelated query", () => {
    expect(matchAcpLocalAgentPresets("kilo")).toEqual([]);
  });
});

describe("isConfiguredAcpLocalAgent", () => {
  it("detects an instance created from the preset", () => {
    expect(
      isConfiguredAcpLocalAgent(
        {
          acpRegistry_oh_my_pi: {
            driver: "acpRegistry",
            config: {
              source: "local",
              localPresetId: "oh-my-pi",
              commandPath: "/home/user/.local/bin/omp",
              commandArgs: ["acp"],
            },
          },
        },
        ohMyPi,
      ),
    ).toBe(true);
  });

  it("detects a manually configured instance by executable and arguments", () => {
    expect(
      isConfiguredAcpLocalAgent(
        {
          acpRegistry_omp: {
            driver: "acpRegistry",
            config: {
              source: "local",
              commandPath: "/usr/local/bin/omp",
              commandArgs: ["acp"],
            },
          },
        },
        ohMyPi,
      ),
    ).toBe(true);
  });

  it("ignores registry agents, other commands, different arguments, and a cleared executable", () => {
    expect(
      isConfiguredAcpLocalAgent(
        {
          acpRegistry_oh_my_pi: {
            driver: "acpRegistry",
            config: { source: "registry", agentId: "oh-my-pi" },
          },
          acpRegistry_other: {
            driver: "acpRegistry",
            config: { source: "local", commandPath: "dsh", commandArgs: ["acp"] },
          },
          acpRegistry_omp: {
            driver: "acpRegistry",
            config: { source: "local", commandPath: "omp", commandArgs: ["--mode", "acp"] },
          },
          acpRegistry_edited_marker: {
            driver: "acpRegistry",
            config: {
              source: "local",
              localPresetId: "oh-my-pi",
              commandPath: "node",
              commandArgs: ["acp"],
            },
          },
          acpRegistry_cleared_command: {
            driver: "acpRegistry",
            config: { source: "local", localPresetId: "oh-my-pi" },
          },
        },
        ohMyPi,
      ),
    ).toBe(false);
  });
});
