import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "@effect/vitest";

import {
  makeWorkPresetName,
  MAX_WORK_PRESETS_PER_ENVIRONMENT,
  getWorkPresetsForEnvironment,
  normalizeWorkPresetsState,
  useWorkPresetsStore,
} from "./workPresetsStore";

const environmentId = EnvironmentId.make("environment-1");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
  options: [{ id: "reasoningEffort", value: "high" as const }],
};

describe("work presets", () => {
  beforeEach(() => {
    useWorkPresetsStore.setState({ presetsByEnvironmentId: {} });
  });

  it("names a model with its selected options and avoids duplicates", () => {
    expect(makeWorkPresetName(modelSelection, new Set())).toBe(
      "gpt-6-astra · reasoningEffort: high",
    );
    expect(
      makeWorkPresetName(modelSelection, new Set(["gpt-6-astra · reasoningEffort: high"])),
    ).toBe("gpt-6-astra · reasoningEffort: high (2)");

    const firstId = useWorkPresetsStore.getState().save(environmentId, modelSelection);
    const secondId = useWorkPresetsStore.getState().save(environmentId, modelSelection);
    expect(secondId).toBe(firstId);
    expect(useWorkPresetsStore.getState().presetsByEnvironmentId[environmentId]).toHaveLength(1);
  });

  it("keeps valid presets scoped to their environment and removes malformed entries", () => {
    const normalized = normalizeWorkPresetsState({
      presetsByEnvironmentId: {
        [environmentId]: [
          {
            id: "valid",
            name: "Valid",
            environmentId,
            modelSelection,
            createdAt: "2026-11-06T00:00:00.000Z",
            updatedAt: "2026-11-06T00:00:00.000Z",
          },
          { id: "broken", environmentId },
          {
            id: "wrong-environment",
            name: "Wrong",
            environmentId: EnvironmentId.make("other"),
            modelSelection,
            createdAt: "2026-11-06T00:00:00.000Z",
            updatedAt: "2026-11-06T00:00:00.000Z",
          },
        ],
      },
    });
    expect(normalized.presetsByEnvironmentId[environmentId]).toHaveLength(1);
    expect(normalized.presetsByEnvironmentId[environmentId]?.[0]?.id).toBe("valid");
    const current = useWorkPresetsStore.getState();
    const hydrated = useWorkPresetsStore.persist.getOptions().merge!(
      { presetsByEnvironmentId: { [environmentId]: [{ id: "broken" }] }, save: null },
      current,
    );
    expect(hydrated.presetsByEnvironmentId).toEqual({});
    expect(hydrated.save).toBe(current.save);
    expect(getWorkPresetsForEnvironment(current, environmentId)).toBe(
      getWorkPresetsForEnvironment(current, environmentId),
    );
  });

  it("limits each environment to the retention size", () => {
    const entries = Array.from({ length: MAX_WORK_PRESETS_PER_ENVIRONMENT + 3 }, (_, index) => ({
      id: `preset-${index}`,
      name: `Preset ${index}`,
      environmentId,
      modelSelection: { ...modelSelection, model: `model-${index}` },
      createdAt: "2026-11-06T00:00:00.000Z",
      updatedAt: "2026-11-06T00:00:00.000Z",
    }));
    expect(
      normalizeWorkPresetsState({ presetsByEnvironmentId: { [environmentId]: entries } })
        .presetsByEnvironmentId[environmentId],
    ).toHaveLength(MAX_WORK_PRESETS_PER_ENVIRONMENT);
  });
});
