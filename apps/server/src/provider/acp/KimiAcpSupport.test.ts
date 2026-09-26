import { describe, expect, it } from "@effect/vitest";
import * as NodeOS from "node:os";

import {
  classifyKimiSubagentLabel,
  KIMI_DEFAULT_MODEL_SLUG,
  resolveKimiAcpBaseModelId,
  resolveKimiCredentialsPath,
  resolveRequestedKimiModeId,
} from "./KimiAcpSupport.ts";

const KIMI_MODES = [
  { id: "default", name: "Default" },
  { id: "plan", name: "Plan" },
  { id: "auto", name: "Auto" },
  { id: "yolo", name: "YOLO" },
];

const modeState = (currentModeId: string = "default") => ({
  currentModeId,
  availableModes: KIMI_MODES,
});

describe("resolveKimiCredentialsPath", () => {
  it("honors KIMI_CODE_HOME and never reads the token file", () => {
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "/custom/kimi-home" })).toBe(
      "/custom/kimi-home/credentials/kimi-code.json",
    );
  });

  it("falls back to ~/.kimi-code", () => {
    const path = resolveKimiCredentialsPath({});
    expect(path).toContain(".kimi-code");
    expect(path.endsWith("credentials/kimi-code.json")).toBe(true);
  });

  it("expands a leading ~/ in KIMI_CODE_HOME against the real home", () => {
    const home = NodeOS.homedir();
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "~/.kimi-code" })).toBe(
      `${home}/.kimi-code/credentials/kimi-code.json`,
    );
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "~" })).toBe(
      `${home}/credentials/kimi-code.json`,
    );
  });

  it("keeps non-tilde overrides verbatim", () => {
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "/data/kimi" })).toBe(
      "/data/kimi/credentials/kimi-code.json",
    );
    // A ~ not at the start is an ordinary directory name, not a home alias.
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "/srv/~/kimi" })).toBe(
      "/srv/~/kimi/credentials/kimi-code.json",
    );
  });
});

describe("resolveKimiAcpBaseModelId", () => {
  it("keeps Kimi's provider-owned model ids verbatim", () => {
    expect(resolveKimiAcpBaseModelId("kimi-code/k3-256k")).toBe("kimi-code/k3-256k");
  });

  it("falls back to the default Kimi model for empty input", () => {
    expect(resolveKimiAcpBaseModelId(undefined)).toBe(KIMI_DEFAULT_MODEL_SLUG);
    expect(resolveKimiAcpBaseModelId("   ")).toBe(KIMI_DEFAULT_MODEL_SLUG);
    expect(KIMI_DEFAULT_MODEL_SLUG).toBe("kimi-code/kimi-for-coding");
  });
});

describe("resolveRequestedKimiModeId", () => {
  it("maps the plan interaction mode onto Kimi's plan mode", () => {
    expect(
      resolveRequestedKimiModeId({
        interactionMode: "plan",
        runtimeMode: "auto",
        modeState: modeState(),
      }),
    ).toBe("plan");
  });

  it("maps runtime modes onto Kimi's live mode ids", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["approval-required", "default"],
      ["auto-accept-edits", "auto"],
      ["auto", "auto"],
      ["full-access", "yolo"],
    ];
    for (const [runtimeMode, expected] of cases) {
      expect(
        resolveRequestedKimiModeId({
          interactionMode: undefined,
          runtimeMode: runtimeMode as never,
          modeState: modeState(),
        }),
      ).toBe(expected);
    }
  });

  it("resolves against the live session modes instead of hardcoding ids", () => {
    const renamed = {
      currentModeId: "safe",
      availableModes: [
        { id: "safe", name: "Default" },
        { id: "deep-thought", name: "Plan" },
        { id: "fast", name: "Auto" },
        { id: "chaos", name: "YOLO" },
      ],
    };
    expect(
      resolveRequestedKimiModeId({
        interactionMode: "plan",
        runtimeMode: "approval-required",
        modeState: renamed,
      }),
    ).toBe("deep-thought");
    expect(
      resolveRequestedKimiModeId({
        interactionMode: undefined,
        runtimeMode: "full-access",
        modeState: renamed,
      }),
    ).toBe("chaos");
  });

  it("keeps the current mode when no advertised mode matches", () => {
    expect(
      resolveRequestedKimiModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
      }),
    ).toBe("default");
  });

  it("returns undefined without mode state", () => {
    expect(
      resolveRequestedKimiModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("classifyKimiSubagentLabel", () => {
  it("classifies Agent and AgentSwarm tool calls by title", () => {
    expect(classifyKimiSubagentLabel("Agent")).toBe("Subagent");
    expect(classifyKimiSubagentLabel(" Agent ")).toBe("Subagent");
    expect(classifyKimiSubagentLabel("agent")).toBe("Subagent");
    expect(classifyKimiSubagentLabel("AgentSwarm")).toBe("Agent swarm");
    expect(classifyKimiSubagentLabel("agentswarm")).toBe("Agent swarm");
  });

  it("leaves ordinary tool calls alone", () => {
    expect(classifyKimiSubagentLabel("Read")).toBeUndefined();
    expect(classifyKimiSubagentLabel(undefined)).toBeUndefined();
    expect(classifyKimiSubagentLabel("")).toBeUndefined();
    expect(classifyKimiSubagentLabel("Subagent")).toBeUndefined();
  });
});
