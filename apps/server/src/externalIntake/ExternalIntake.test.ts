import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationProjectShell } from "@t3tools/contracts";

import {
  modelSelectionFromIntakeTags,
  resolveIntakeProjectRoutingTarget,
} from "./ExternalIntake.ts";
import type { IntakeProjectProfile } from "./profiles.ts";

const now = "2026-06-18T00:00:00.000Z";

function projectShell(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}): OrchestrationProjectShell {
  return {
    id: input.id,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as OrchestrationProjectShell;
}

function profile(input: {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly aliases?: readonly string[];
}): IntakeProjectProfile {
  return {
    id: input.id,
    workspaceRoot: input.workspaceRoot,
    aliases: input.aliases ?? [input.id],
  };
}

describe("modelSelectionFromIntakeTags", () => {
  it("returns undefined when no routing tag is present", () => {
    expect(modelSelectionFromIntakeTags("please add dark mode")).toBeUndefined();
  });

  it.each([
    ["codex-fast", "medium", "priority"],
    ["codex", "medium", "default"],
    ["codex-high-fast", "high", "priority"],
    ["codex-high", "high", "default"],
  ])("routes [%s] to GPT-5.5 with the requested Codex traits", (tag, reasoning, serviceTier) => {
    expect(modelSelectionFromIntakeTags(`[${tag}] fix the build`)).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
      options: [
        { id: "reasoningEffort", value: reasoning },
        { id: "serviceTier", value: serviceTier },
      ],
    });
  });

  it.each([
    ["codex-fast", "medium", "priority"],
    ["codex", "medium", "default"],
    ["codex-high-fast", "high", "priority"],
    ["codex-high", "high", "default"],
  ])(
    "routes a leading %s: prefix to GPT-5.5 with the requested Codex traits",
    (tag, reasoning, serviceTier) => {
      expect(modelSelectionFromIntakeTags(`${tag}: fix the build`)).toEqual({
        instanceId: "codex",
        model: "gpt-5.5",
        options: [
          { id: "reasoningEffort", value: reasoning },
          { id: "serviceTier", value: serviceTier },
        ],
      });
    },
  );

  it("routes [claude] to Opus 4.8 at extra-high effort", () => {
    expect(modelSelectionFromIntakeTags("[claude] refactor the parser")).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-4-8",
      options: [{ id: "effort", value: "xhigh" }],
    });
  });

  it.each([
    ["glm", "openrouter/z-ai/glm-5.2"],
    ["kimi", "openrouter/moonshotai/kimi-k2.7-code"],
  ])("routes [%s] to OpenCode with the requested OpenRouter model", (tag, model) => {
    expect(modelSelectionFromIntakeTags(`[${tag}] fix the build`)).toEqual({
      instanceId: "opencode",
      model,
    });
  });

  it.each([
    ["glm", "openrouter/z-ai/glm-5.2"],
    ["kimi", "openrouter/moonshotai/kimi-k2.7-code"],
  ])("routes a leading %s: prefix to OpenCode with the requested model", (tag, model) => {
    expect(modelSelectionFromIntakeTags(`${tag}: fix the build`)).toEqual({
      instanceId: "opencode",
      model,
    });
  });

  it.each([
    ["claude", "claude-opus-4-8", "xhigh"],
    ["claude-opus", "claude-opus-4-8", "xhigh"],
    ["claude-opus-high", "claude-opus-4-8", "high"],
    ["claude-opus-ultracode", "claude-opus-4-8", "ultracode"],
    ["claude-fable", "claude-fable-5", "high"],
    ["claude-fable-xhigh", "claude-fable-5", "xhigh"],
    ["claude-fable-ultracode", "claude-fable-5", "ultracode"],
  ])("routes [%s] to the requested Claude model and effort", (tag, model, effort) => {
    expect(modelSelectionFromIntakeTags(`[${tag}] refactor the parser`)).toEqual({
      instanceId: "claudeAgent",
      model,
      options: [{ id: "effort", value: effort }],
    });
  });

  it.each([
    ["claude", "claude-opus-4-8", "xhigh"],
    ["claude-opus", "claude-opus-4-8", "xhigh"],
    ["claude-opus-high", "claude-opus-4-8", "high"],
    ["claude-opus-ultracode", "claude-opus-4-8", "ultracode"],
    ["claude-fable", "claude-fable-5", "high"],
    ["claude-fable-xhigh", "claude-fable-5", "xhigh"],
    ["claude-fable-ultracode", "claude-fable-5", "ultracode"],
  ])(
    "routes a leading %s: prefix to the requested Claude model and effort",
    (tag, model, effort) => {
      expect(modelSelectionFromIntakeTags(`${tag}: refactor the parser`)).toEqual({
        instanceId: "claudeAgent",
        model,
        options: [{ id: "effort", value: effort }],
      });
    },
  );

  it("is case-insensitive and matches tags anywhere in the message", () => {
    expect(modelSelectionFromIntakeTags("ship it [CODEX-HIGH-FAST] now")).toMatchObject({
      instanceId: "codex",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ],
    });
    expect(modelSelectionFromIntakeTags("ship it [Claude] now")?.instanceId).toBe("claudeAgent");
  });

  it("prefers whichever tag appears first when both are present", () => {
    expect(modelSelectionFromIntakeTags("[codex-high] vs [claude]")).toMatchObject({
      instanceId: "codex",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "default" },
      ],
    });
    expect(modelSelectionFromIntakeTags("[claude] vs [codex]")?.instanceId).toBe("claudeAgent");
    expect(modelSelectionFromIntakeTags("[claude] then codex-fast: do this")?.instanceId).toBe(
      "claudeAgent",
    );
  });

  it("ignores bare words without brackets", () => {
    expect(modelSelectionFromIntakeTags("use codex or claude here")).toBeUndefined();
  });

  it("does not expose ultrathink routing tags", () => {
    expect(modelSelectionFromIntakeTags("[claude-opus-ultrathink] fix the build")).toBeUndefined();
    expect(modelSelectionFromIntakeTags("claude-fable-ultrathink: fix the build")).toBeUndefined();
  });
});

describe("resolveIntakeProjectRoutingTarget", () => {
  it("lets an active project mentioned in the request beat a conflicting source hint", () => {
    const nextcard = profile({
      id: "nextcard",
      workspaceRoot: "/workspace/nextcard",
      aliases: ["nextcard"],
    });
    const t3code = projectShell({
      id: "project-t3code",
      title: "t3code",
      workspaceRoot: "/workspace/t3code",
    });

    expect(
      resolveIntakeProjectRoutingTarget({
        profiles: [nextcard],
        projects: [
          projectShell({
            id: "project-nextcard",
            title: "nextcard",
            workspaceRoot: "/workspace/nextcard",
          }),
          t3code,
        ],
        text: "[claude-opus-ultracode] in t3code, make a dashboard page",
        projectHintText: "nextcard support triage context",
        fallbackProfile: nextcard,
      }),
    ).toEqual({ type: "project", project: t3code });
  });

  it("routes to a configured t3code intake profile when the request names it", () => {
    const t3codeProfile = profile({
      id: "t3code",
      workspaceRoot: "/workspace/t3code",
      aliases: ["t3code", "t3 code"],
    });

    expect(
      resolveIntakeProjectRoutingTarget({
        profiles: [
          profile({
            id: "nextcard",
            workspaceRoot: "/workspace/nextcard",
            aliases: ["nextcard"],
          }),
          t3codeProfile,
        ],
        projects: [
          projectShell({
            id: "project-t3code",
            title: "t3code",
            workspaceRoot: "/workspace/t3code",
          }),
        ],
        text: "please do this in t3 code",
        projectHintText: "nextcard",
      }),
    ).toEqual({ type: "profile", profile: t3codeProfile });
  });
});
