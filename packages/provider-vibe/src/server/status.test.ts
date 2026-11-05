import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  vibeAuthFromStatusReport,
  vibeModelsFromConfigOptions,
  vibeProbeStatus,
  vibeRuntimeModes,
} from "./status.ts";

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
  it("lists Default and Vibe's models, with thinking only where Vibe listed it", () => {
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
      models.map((model) =>
        model.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id),
      ),
      [["thinking"], ["thinking"], []],
    );
  });

  it("offers only Default before Vibe is signed in", () => {
    assert.deepEqual(
      vibeModelsFromConfigOptions([]).map((model) => model.name),
      ["Default"],
    );
  });
});

describe("vibeProbeStatus", () => {
  it("keeps a confirmed sign-in when the model list fails", () => {
    assert.deepEqual(vibeProbeStatus({ status: "authenticated" }, VIBE_CONFIG_OPTIONS), {
      status: "ready",
    });
    assert.deepEqual(vibeProbeStatus({ status: "authenticated" }, undefined), {
      status: "warning",
      message: "Mistral Vibe is signed in but its models could not be listed.",
    });
    assert.equal(vibeProbeStatus({ status: "unauthenticated" }, undefined).status, "error");
    assert.equal(vibeProbeStatus({ status: "unknown" }, undefined).status, "warning");
  });
});

const onlyAgents = (agents: ReadonlyArray<string>) =>
  VIBE_CONFIG_OPTIONS.map((option) =>
    option.id === "mode"
      ? { ...option, options: agents.map((agent) => ({ value: agent, name: agent })) }
      : option,
  );

describe("vibeRuntimeModes", () => {
  it("offers only the modes whose Vibe agent the session lists", () => {
    const allModes = ["approval-required", "auto-accept-edits", "full-access"] as const;
    assert.deepEqual(vibeRuntimeModes(VIBE_CONFIG_OPTIONS), allModes);
    assert.deepEqual(vibeRuntimeModes(undefined), allModes);
    assert.deepEqual(vibeRuntimeModes(onlyAgents(["ask", "accept-edits"])), [
      "approval-required",
      "auto-accept-edits",
    ]);
  });

  // `enabled_agents = ["smart-approve"]` leaves no agent T3 Code can select.
  it("reports a Vibe that enables none of T3's agents", () => {
    const smartOnly = onlyAgents(["smart-approve"]);
    assert.deepEqual(vibeRuntimeModes(smartOnly), []);
    assert.equal(vibeProbeStatus({ status: "authenticated" }, smartOnly).status, "error");
  });
});
