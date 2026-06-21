import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { resolveExecutionBridgeModelSelection } from "./requestDefaults.ts";

const projectDefault: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-7",
};

describe("resolveExecutionBridgeModelSelection", () => {
  it("uses an explicit bridge request model first", () => {
    const explicit: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };

    expect(resolveExecutionBridgeModelSelection({ modelSelection: explicit }, projectDefault)).toBe(
      explicit,
    );
  });

  it("uses process bootstrap defaults before a stale project default", () => {
    const previousProvider = process.env.T3_DEFAULT_PROVIDER_INSTANCE_ID;
    const previousModel = process.env.T3_DEFAULT_MODEL;
    process.env.T3_DEFAULT_PROVIDER_INSTANCE_ID = "claudeAgent";
    process.env.T3_DEFAULT_MODEL = "claude-sonnet-4-6";

    try {
      expect(
        resolveExecutionBridgeModelSelection({ modelSelection: undefined }, projectDefault),
      ).toMatchObject({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      });
    } finally {
      if (previousProvider === undefined) {
        delete process.env.T3_DEFAULT_PROVIDER_INSTANCE_ID;
      } else {
        process.env.T3_DEFAULT_PROVIDER_INSTANCE_ID = previousProvider;
      }
      if (previousModel === undefined) {
        delete process.env.T3_DEFAULT_MODEL;
      } else {
        process.env.T3_DEFAULT_MODEL = previousModel;
      }
    }
  });

  it("uses the existing project default when no process default is configured", () => {
    const previousProvider = process.env.T3_DEFAULT_PROVIDER_INSTANCE_ID;
    const previousModel = process.env.T3_DEFAULT_MODEL;
    delete process.env.T3_DEFAULT_PROVIDER_INSTANCE_ID;
    delete process.env.T3_DEFAULT_MODEL;

    try {
      expect(
        resolveExecutionBridgeModelSelection({ modelSelection: undefined }, projectDefault),
      ).toBe(projectDefault);
    } finally {
      if (previousProvider !== undefined) {
        process.env.T3_DEFAULT_PROVIDER_INSTANCE_ID = previousProvider;
      }
      if (previousModel !== undefined) {
        process.env.T3_DEFAULT_MODEL = previousModel;
      }
    }
  });
});
