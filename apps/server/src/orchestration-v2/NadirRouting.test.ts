import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  baselineFor,
  forgetChoices,
  nadirRequestBody,
  pickModel,
  rememberChoice,
  routedSelection,
} from "./NadirRouting.ts";

const menu = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
const context = { baseline: "claude-opus-4-6", current: "claude-opus-4-6", menu };
const routed = (model: string, extra: Record<string, unknown> = {}) => ({
  selected_model: model,
  coverage_held: false,
  input_truncated: false,
  policy: { advised_model: model, suppressed: false },
  ...extra,
});

describe("pickModel", () => {
  it("takes Nadir's qualified pick from the menu", () => {
    expect(pickModel(routed("claude-haiku-4-5"), context)).toBe("claude-haiku-4-5");
  });

  it.each([
    ["no answer", null],
    ["a model outside the menu", routed("gpt-5.5")],
    [
      "a suppressed saving",
      routed("claude-haiku-4-5", {
        policy: { advised_model: "claude-haiku-4-5", suppressed: true },
      }),
    ],
    [
      "advice that disagrees with the pick",
      routed("claude-haiku-4-5", {
        policy: { advised_model: "claude-sonnet-4-6", suppressed: false },
      }),
    ],
    ["a truncated prompt", routed("claude-haiku-4-5", { input_truncated: true })],
    ["held coverage", routed("claude-haiku-4-5", { coverage_held: true })],
    [
      "a warm cache worth keeping",
      routed("claude-haiku-4-5", { cache_advice: { decision: "stay_warm" } }),
    ],
  ])("keeps the user's pick on %s", (_label, answer) => {
    expect(pickModel(answer, context)).toBe("claude-opus-4-6");
  });

  it("keeps a cheaper model that already holds the cache when Nadir picks it again", () => {
    const answer = routed("claude-haiku-4-5", {
      policy: { advised_model: "claude-haiku-4-5", suppressed: true },
    });
    expect(pickModel(answer, { ...context, current: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
  });

  it("follows an organization's governance model when the menu has it", () => {
    expect(pickModel({ governance_model: "claude-sonnet-4-6" }, context)).toBe("claude-sonnet-4-6");
    expect(pickModel({ governance_model: "gpt-5.5" }, context)).toBe("claude-opus-4-6");
  });
});

describe("baselineFor", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const opus: ModelSelection = { instanceId, model: "claude-opus-4-6", options: [] };
  const haiku: ModelSelection = { instanceId, model: "claude-haiku-4-5" };

  it("keeps the user's pick as the ceiling after Nadir routes down", () => {
    forgetChoices();
    rememberChoice("thread-1", opus, haiku);
    // The picker now shows Haiku; sending again must not make Haiku the ceiling.
    expect(baselineFor("thread-1", haiku)).toBe(opus);
  });

  it("treats a model the user picks by hand as the new ceiling", () => {
    forgetChoices();
    rememberChoice("thread-1", opus, haiku);
    const sonnet: ModelSelection = { instanceId, model: "claude-sonnet-4-6" };
    expect(baselineFor("thread-1", sonnet)).toBe(sonnet);
    expect(baselineFor("thread-2", haiku)).toBe(haiku);
    // Changing only the effort of the model Nadir chose is a pick too.
    const haikuHigh: ModelSelection = { ...haiku, options: [{ id: "effort", value: "high" }] };
    expect(baselineFor("thread-1", haikuHigh)).toBe(haikuHigh);
  });
});

describe("routedSelection", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const model = (slug: string, efforts: string[], defaultEffort: string, fast = false) =>
    ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: efforts.map((id) => ({ id, label: id, isDefault: id === defaultEffort })),
          },
          ...(fast ? [{ id: "fastMode", label: "Fast", type: "boolean" as const }] : []),
        ],
      },
    }) satisfies ServerProviderModel;
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "0.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-06T00:00:00.000Z",
    models: [
      model("opus", ["low", "medium", "high", "max"], "medium", true),
      model("sonnet", ["medium", "high", "max"], "high"),
      model("haiku", ["low", "medium", "high"], "medium"),
    ],
    slashCommands: [],
    skills: [],
  };

  it.each([
    [
      "the effort the picker showed, not the routed model's default",
      undefined,
      "sonnet",
      [{ id: "effort", value: "medium" }],
    ],
    [
      "a stated effort, dropping options the routed model lacks",
      [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ],
      "sonnet",
      [{ id: "effort", value: "max" }],
    ],
    [
      "the routed model's default when it lacks the level",
      [{ id: "effort", value: "max" }],
      "haiku",
      [{ id: "effort", value: "medium" }],
    ],
  ])("keeps %s", (_label, options, target, expected) => {
    const baseline: ModelSelection = { instanceId, model: "opus", ...(options ? { options } : {}) };
    expect(routedSelection(baseline, target, provider)).toEqual({
      instanceId,
      model: target,
      options: expected,
    });
  });
});

describe("nadirRequestBody", () => {
  it("never lets Nadir route above the user's pick and prices the warm cache", () => {
    const body = nadirRequestBody({
      text: "Rename foo to bar in format.ts",
      baseline: "claude-opus-4-6",
      menu,
      driver: "claudeAgent",
      threadId: "thread-1",
      cache: { model: "claude-opus-4-6", contextTokens: 120_000 },
    });
    expect(body).toMatchObject({
      requested_model: "claude-opus-4-6",
      menu,
      policy: { allow_route_up: false },
      agent_session: { client: "claude-code", session_id: "thread-1" },
      cache: { model: "claude-opus-4-6", current_input_tokens: 120_000 },
    });
  });
});
