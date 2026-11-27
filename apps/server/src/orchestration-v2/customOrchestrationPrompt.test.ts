import {
  ProviderInstanceId,
  type CustomOrchestrationSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  customOrchestrationInstructions,
  expandCustomOrchestrationCommand,
} from "./customOrchestrationPrompt.ts";

const reviewer = (instance: string, model: string) => ({
  instanceId: ProviderInstanceId.make(instance),
  model,
});

const only = (instance: string, model: string) => ({
  modelSelection: reviewer(instance, model),
  fallbacks: [],
});

const settings: CustomOrchestrationSettings = {
  orchestrator: {
    modelSelection: reviewer("claudeAgent", "orchestrator-model"),
    fallbacks: [reviewer("codex", "spare-orchestrator")],
  },
  tasks: [
    {
      id: "deep",
      name: "Deep thinking",
      description: "hard design\nquestions",
      modelSelection: {
        ...reviewer("codex", "deep-model"),
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      fallbacks: [reviewer("claudeAgent", "deep-fallback")],
    },
    {
      id: "ml",
      name: "ML",
      description: "",
      ...only("claudeAgent", "ml-model"),
    },
  ],
  commands: [
    {
      name: "extreme-review",
      instructions: "Focus on data loss.",
      reviewers: [
        {
          modelSelection: reviewer("claudeAgent", "first-model"),
          fallbacks: [reviewer("codex", "first-fallback")],
        },
        only("codex", "second-model"),
      ],
    },
  ],
};

/** A turn on the orchestrator itself, with the named models at their usage limit. */
const turn = (limited: ReadonlyArray<string> = [], running = "orchestrator-model") => ({
  running: reviewer("claudeAgent", running),
  problemOf: (selection: ModelSelection) =>
    limited.includes(selection.model) ? { kind: "limit" as const, resetsAt: null } : null,
});

describe("customOrchestrationInstructions", () => {
  it("names each task kind with the exact delegate_task target", () => {
    const text = customOrchestrationInstructions(settings, turn());

    expect(text).toContain(
      '- Deep thinking (hard design questions): {"providerInstanceId":"codex","model":"deep-model","options":[{"id":"reasoningEffort","value":"xhigh"}]} then {"providerInstanceId":"claudeAgent","model":"deep-fallback","options":[]}',
    );
    // Without `options`, a target on the orchestrator's provider would inherit its effort.
    expect(text).toContain(
      '- ML: {"providerInstanceId":"claudeAgent","model":"ml-model","options":[]}',
    );
  });

  it("keeps the review rule when no task kinds are configured", () => {
    const text = customOrchestrationInstructions({ ...settings, tasks: [] }, turn());

    expect(text).not.toContain("delegate_task");
    expect(text).toContain("delegate nothing for it");
  });

  it("offers only fallbacks while a model is unavailable, and has the user told", () => {
    const text = customOrchestrationInstructions(settings, turn(["deep-model", "ml-model"]));

    expect(text).not.toContain('"model":"deep-model"');
    expect(text).toContain(
      '- Deep thinking (hard design questions): {"providerInstanceId":"claudeAgent","model":"deep-fallback","options":[]}. Unavailable now: deep-model (it is at its usage limit). Tell the user that a fallback is standing in.',
    );
    expect(text).toContain(
      "- ML: no configured model can run: ml-model (it is at its usage limit). If this work comes up, tell the user and skip it.",
    );
  });

  it("says nothing about a fallback that is unavailable while the model itself can run", () => {
    const text = customOrchestrationInstructions(settings, turn(["deep-fallback"]));

    expect(text).not.toContain("Unavailable now");
    expect(text).not.toContain('"model":"deep-fallback"');
  });

  it("tells a fallback orchestrator why it is standing in", () => {
    const standingIn = (limited: ReadonlyArray<string>) =>
      customOrchestrationInstructions(settings, turn(limited, "spare-orchestrator"));

    expect(standingIn(["orchestrator-model"])).toContain(
      "orchestrator-model cannot run now because it is at its usage limit, so you are running as its fallback spare-orchestrator.",
    );
    expect(standingIn([])).not.toContain("running as its fallback");
  });
});

describe("expandCustomOrchestrationCommand", () => {
  it("asks every reviewer, keeping what the user typed after the command", () => {
    const text = expandCustomOrchestrationCommand(
      "/extreme-review the auth change\nespecially refresh",
      settings,
      turn(),
    );

    expect(text).toContain('"model":"first-model"');
    expect(text).toContain('"model":"second-model"');
    expect(text).toContain("Focus on data loss.");
    expect(text).toMatch(/\n\nthe auth change\nespecially refresh$/u);
    expect(text?.startsWith("/")).toBe(false);
  });

  it("hands a reviewer that cannot run to its fallback", () => {
    const text = expandCustomOrchestrationCommand(
      "/extreme-review",
      settings,
      turn(["first-model", "second-model"]),
    );

    expect(text).not.toContain('"model":"first-model"');
    expect(text).toContain('"model":"first-fallback"');
    expect(text).toContain(
      "- no configured model can run: second-model (it is at its usage limit). Go on without this reviewer.",
    );
  });

  it.each(["/review", "/extreme-reviews", "please /extreme-review", "/code-review main"])(
    "leaves %s to the provider",
    (typed) => {
      expect(expandCustomOrchestrationCommand(typed, settings, turn())).toBeUndefined();
    },
  );

  it("never lets a hand-edited command shadow the harness's review", () => {
    const edited = { ...settings, commands: [{ ...settings.commands[0]!, name: "review" }] };

    expect(expandCustomOrchestrationCommand("/review", edited, turn())).toBeUndefined();
  });
});
