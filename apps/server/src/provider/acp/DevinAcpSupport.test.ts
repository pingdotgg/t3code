import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "@effect/vitest";

import { applyDevinAcpModelSelection, buildDevinAcpSpawnInput } from "./DevinAcpSupport.ts";

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default command", () => {
    expect(buildDevinAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("places global flags before acp and subcommand flags after it", () => {
    expect(
      buildDevinAcpSpawnInput(
        {
          binaryPath: "/opt/devin",
          configPath: "/tmp/config.json",
          agentConfigPath: "/tmp/agent.json",
          sandbox: true,
          respectWorkspaceTrust: false,
          agentType: "review",
          launchArgs: '--permission-mode smart --model "swe-1-7-medium"',
          acpArgs: "--future-acp-flag",
        },
        "/tmp/project",
        { DEVIN_MODEL: "adaptive" },
      ),
    ).toEqual({
      command: "/opt/devin",
      args: [
        "--config",
        "/tmp/config.json",
        "--agent-config",
        "/tmp/agent.json",
        "--sandbox",
        "--respect-workspace-trust",
        "false",
        "--permission-mode",
        "smart",
        "--model",
        "swe-1-7-medium",
        "acp",
        "--agent-type",
        "review",
        "--future-acp-flag",
      ],
      cwd: "/tmp/project",
      env: { DEVIN_MODEL: "adaptive" },
    });
  });
});

describe("applyDevinAcpModelSelection", () => {
  it.effect("selects the model and applies only negotiated config options", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string | boolean]> = [];
      const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "adaptive",
          options: [{ value: "adaptive", name: "Adaptive" }],
        },
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "medium",
          options: [{ value: "medium", name: "Medium" }],
        },
      ];

      yield* applyDevinAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed(configOptions),
          setModel: (model) =>
            Effect.sync(() => {
              calls.push(["model", model]);
            }),
          setConfigOption: (id, value) =>
            Effect.sync(() => {
              calls.push([id, value]);
            }),
        },
        model: "swe-1-7-medium",
        selections: [
          { id: "effort", value: "medium" },
          { id: "unknown-future-option", value: true },
        ],
        mapError: ({ cause }) => cause,
      });

      expect(calls).toEqual([
        ["model", "swe-1-7-medium"],
        ["effort", "medium"],
      ]);
    }),
  );
});
