import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  buildAntigravityProviderModels,
  detectAntigravityProjectIdForCwd,
  parseAntigravityModelLabel,
  parseAntigravityLanguageServerCmdline,
  parseLinuxTcpListenPortsForInodes,
  resolveAntigravityModelLabel,
} from "./AntigravityProvider.ts";

describe("AntigravityProvider model helpers", () => {
  it("groups Antigravity model labels into base models with reasoning options", () => {
    const models = buildAntigravityProviderModels({
      labels: [
        "Gemini 3.5 Flash (Medium)",
        "Gemini 3.5 Flash (High)",
        "Gemini 3.5 Flash (Low)",
        "Gemini 3.1 Pro (Low)",
        "Gemini 3.1 Pro (High)",
        "Claude Sonnet 4.6 (Thinking)",
      ],
    });

    expect(models.map((model) => model.name)).toEqual([
      "Gemini 3.5 Flash",
      "Gemini 3.1 Pro",
      "Claude Sonnet 4.6",
    ]);

    const flash = models.find((model) => model.name === "Gemini 3.5 Flash");
    expect(flash?.slug).toBe("Gemini 3.5 Flash (Medium)");
    expect(flash?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "medium",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
      },
    ]);
  });

  it("resolves the concrete Antigravity label from model and reasoning selections", () => {
    expect(parseAntigravityModelLabel("Gemini 3.5 Flash (High)")).toEqual({
      baseName: "Gemini 3.5 Flash",
      reasoningEffort: "high",
    });

    expect(
      resolveAntigravityModelLabel({
        instanceId: ProviderInstanceId.make("antigravity"),
        model: "Gemini 3.5 Flash (Medium)",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toBe("Gemini 3.5 Flash (High)");
  });
});

describe("AntigravityProvider daemon discovery helpers", () => {
  it("extracts the CSRF token from an Antigravity language_server process", () => {
    expect(
      parseAntigravityLanguageServerCmdline([
        "/opt/antigravity2/resources/bin/language_server",
        "--standalone",
        "--csrf_token",
        "token-123",
      ]),
    ).toEqual({ csrfToken: "token-123" });

    expect(parseAntigravityLanguageServerCmdline(["node", "server.js"])).toBeUndefined();
  });

  it("extracts sorted loopback listen ports for matching socket inodes", () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:89CD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0",
      "   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000000000000000 100 0 0 10 0",
      "   2: 0100007F:A77B 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 67890 1 0000000000000000 100 0 0 10 0",
    ].join("\n");

    expect(parseLinuxTcpListenPortsForInodes(tcp, new Set(["12345", "67890"]))).toEqual([35277]);
  });

  it("detects the configured project id for this workspace when Antigravity config exists", () => {
    const projectId = detectAntigravityProjectIdForCwd("/home/coder/Code/playground/t3code");

    if (projectId !== undefined) {
      expect(projectId).toBe("a1de9f3a-657d-489b-9d4c-896670de1997");
    }
  });
});
