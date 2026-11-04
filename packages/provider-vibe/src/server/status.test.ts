import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { vibeAuthFromStatusReport, vibeModelsFromConfigOptions } from "./status.ts";

// Shaped like vibe-acp 3.0.3's `session/new` config options.
const VIBE_CONFIG_OPTIONS = [
  {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: "accept-edits",
    options: [
      { value: "ask", name: "Ask", description: "Requires approval for tool executions" },
      { value: "accept-edits", name: "Accept Edits", description: "Auto-approves file edits only" },
      {
        value: "auto-approve",
        name: "Auto Approve",
        description: "Auto-approves all tool executions",
      },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "mistral-medium-3.5",
    options: [
      {
        value: "mistral-medium-3.5",
        name: "Mistral Medium 3.5",
        description: "mistral-vibe-cli-latest",
      },
      { value: "devstral-small", name: "Devstral Small" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thinking",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "high", name: "High" },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("vibeAuthFromStatusReport", () => {
  it("reads `_auth/status`", () => {
    assert.deepEqual(vibeAuthFromStatusReport({ authenticated: true, authState: "os_keyring" }), {
      status: "authenticated",
    });
    assert.deepEqual(vibeAuthFromStatusReport({ authenticated: false, authState: "missing" }), {
      status: "unauthenticated",
    });
    assert.deepEqual(vibeAuthFromStatusReport({ authState: "os_keyring" }), { status: "unknown" });
    assert.deepEqual(vibeAuthFromStatusReport(null), { status: "unknown" });
  });
});

describe("vibeModelsFromConfigOptions", () => {
  it("lists Default and Vibe's models, with thinking but not the agent mode", () => {
    const models = vibeModelsFromConfigOptions(VIBE_CONFIG_OPTIONS);
    assert.deepEqual(
      models.map((model) => [model.slug, model.name, model.isDefault ?? false]),
      [
        ["default", "Default (Mistral Medium 3.5)", true],
        ["mistral-medium-3.5", "Mistral Medium 3.5", false],
        ["devstral-small", "Devstral Small", false],
      ],
    );
    assert.deepEqual(models[0]?.aliases, ["mistral-medium-3.5"]);
    assert.deepEqual(
      models[0]?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id),
      ["thinking"],
    );
  });

  it("offers only Default before Vibe is signed in", () => {
    assert.deepEqual(
      vibeModelsFromConfigOptions([]).map((model) => model.name),
      ["Default"],
    );
  });
});
