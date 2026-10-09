import { describe, expect, it } from "@effect/vitest";

import type { ServerProvider } from "@t3tools/contracts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";

import { normalizeZCodeCommands } from "./liveState.ts";
import { applyZCodeLiveState, zcodeModelsFromLiveConfiguration } from "./status.ts";

describe("zcodeModelsFromLiveConfiguration", () => {
  const configuration = {
    models: [
      { id: "plan\\GLM-Example", name: "GLM Example", description: null },
      { id: "plan\\GLM-Example-Flash", name: "GLM Example Flash", description: null },
    ],
    configOptions: [
      {
        id: "mode",
        label: "Mode",
        type: "select" as const,
        options: [{ id: "build", label: "Build" }],
      },
      {
        id: "thought",
        label: "Thinking",
        type: "select" as const,
        options: [
          { id: "low", label: "Low" },
          { id: "max", label: "Max" },
        ],
      },
    ],
  };

  it("keeps the default alias first, then the session's models", () => {
    const models = zcodeModelsFromLiveConfiguration(configuration, []);
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["zcode-default", "ZCode default"],
      ["plan\\GLM-Example", "GLM Example"],
      ["plan\\GLM-Example-Flash", "GLM Example Flash"],
    ]);
  });

  it("offers thinking options but leaves the permission mode to T3", () => {
    const [model] = zcodeModelsFromLiveConfiguration(configuration, []);
    const optionIds = model?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id);
    expect(optionIds).toEqual(["thought"]);
  });
});

describe("applyZCodeLiveState", () => {
  const provider = {
    models: [],
    slashCommands: [COMPACT_SLASH_COMMAND],
    skills: [],
  } as unknown as ServerProvider;

  it("keeps the status snapshot until a session advertises something", () => {
    expect(
      applyZCodeLiveState(provider, { configuration: undefined, commands: undefined }, []),
    ).toEqual(provider);
  });

  it("adds the session's commands and keeps T3's compact command", () => {
    const live = applyZCodeLiveState(
      provider,
      {
        configuration: undefined,
        commands: normalizeZCodeCommands([
          { name: "review", description: "Review changes" },
          { name: "$frontend-design", description: "Design skill" },
        ]),
      },
      [],
    );
    expect(live.slashCommands.map((command) => command.name)).toEqual([
      COMPACT_SLASH_COMMAND.name,
      "review",
    ]);
    expect(live.skills.map((skill) => skill.name)).toEqual(["frontend-design"]);
  });
});
