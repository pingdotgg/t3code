import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type McpGatewayProfile,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  agentInstructionsInContext,
  agentProfilePrompt,
  agentProfileReminder,
  resolveThreadCreateProfile,
} from "./AgentProfile.ts";
import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
} from "../provider/ClaudeModelCatalog.ts";

const profile: McpGatewayProfile = {
  profileId: "review",
  name: "Reviewer",
  revision: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  reasoningEffort: "high",
  systemPrompt: "Review changes carefully.",
};
const command = { profileSelection: { profileId: "review", revision: 3, overrideFields: [] } };

describe("V2 profile association", () => {
  it("freezes instructions and defaults independently of subsequent library edits", () => {
    const resolved = resolveThreadCreateProfile(command, [profile]);
    expect(resolved).toMatchObject({
      runtimeMode: "approval-required",
      modelSelection: {
        model: "test-model",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      profileSnapshot: { profileId: "review", revision: 3 },
    });
    const edited = { ...profile, revision: 4, systemPrompt: "New instructions" };
    expect(() => resolveThreadCreateProfile(command, [edited])).toThrow(/stale/);
    const prompt = resolved.profileContent?.systemPrompt;
    expect(agentProfilePrompt("Check this patch", prompt)).toContain("Review changes carefully.");
    expect(agentProfilePrompt("Check this patch", prompt)).not.toContain("New instructions");
    expect(agentProfilePrompt("Normal chat", undefined)).toBe("Normal chat");
    expect(resolved.profileSnapshot).not.toHaveProperty("includeUserSkills");
    expect(
      resolveThreadCreateProfile(command, [{ ...profile, includeUserSkills: false }])
        .profileSnapshot?.includeUserSkills,
    ).toBe(false);
  });
  it("names the agent and its skills in the reminder for turns that skip the full prompt", () => {
    const skill = (name: string) => ({
      skillId: name,
      name,
      description: "unused",
      content: "unused",
      revision: 1,
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(
      agentProfileReminder("Wake", "Captain", {
        systemPrompt: "Sweep every child.",
        skills: [skill("captain-event-loop"), skill("pr")],
      }),
    ).toBe(
      '<agent_profile_reminder>You are running as the Ada agent "Captain". Your agent_profile_instructions and assigned skills (captain-event-loop, pr) from the start of this conversation still apply; re-read a skill\'s SKILL.md when its trigger applies.</agent_profile_reminder>\n\nWake',
    );
    expect(agentProfileReminder("Wake", "Captain", { systemPrompt: "  ", skills: [] })).toBe(
      "Wake",
    );
  });
  it("freezes only the selected skill bundles with the profile", () => {
    const skill = {
      skillId: "review",
      name: "Review",
      description: "Review rules",
      content: "Check invariants",
      resources: [{ path: "references/rules.md", contentBase64: "b2s=" }],
      revision: 2,
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
    };
    const resolved = resolveThreadCreateProfile(
      command,
      [{ ...profile, skillIds: ["review"] }],
      [],
      [skill, { ...skill, skillId: "unrelated" }],
    );
    expect(resolved.profileContent?.skills).toEqual([skill]);
    expect(
      resolveThreadCreateProfile(command, [profile], [], [skill]).profileContent?.skills,
    ).toEqual([]);
  });
  it("rejects missing, stale, read-only profiles and incomplete overrides", () => {
    expect(() => resolveThreadCreateProfile(command, [])).toThrow(/missing/);
    expect(() =>
      resolveThreadCreateProfile(command, [{ ...profile, runtimeMode: "read-only" }]),
    ).toThrow(/read-only/);
    expect(() =>
      resolveThreadCreateProfile(
        { profileSelection: { ...command.profileSelection, overrideFields: ["modelSelection"] } },
        [profile],
      ),
    ).toThrow(/override/);
  });
  it("records an explicit model override while retaining profile instructions", () => {
    const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "other" };
    const resolved = resolveThreadCreateProfile(
      {
        modelSelection,
        profileSelection: {
          ...command.profileSelection,
          overrideFields: ["modelSelection", "reasoningEffort"],
        },
      },
      [profile],
    );
    expect(resolved.modelSelection).toEqual(modelSelection);
    expect(resolved.profileSnapshot?.effectiveSource.modelSelection).toBe("thread-override");
    expect(resolved.profileContent?.systemPrompt).toBe(profile.systemPrompt);
  });
  it("applies the agent's effort under the selected model's own effort option", () => {
    const levels = ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id }));
    const provider = (
      instanceId: string,
      displayName: string,
      descriptor: Record<string, unknown>,
    ) =>
      ({
        instanceId: ProviderInstanceId.make(instanceId),
        driver: instanceId,
        displayName,
        enabled: true,
        models: [
          {
            slug: `${instanceId}-model`,
            name: `${displayName} Model`,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                { label: "Effort", type: "select", options: levels, ...descriptor },
              ],
            },
          },
        ],
      }) as unknown as ServerProvider;
    const providers = [
      provider("antigravity", "Antigravity", { id: "thought_level", role: "reasoning" }),
      provider("codex", "Codex", { id: "reasoningEffort" }),
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        models: [
          {
            slug: "claude-opus-5-5",
            name: "Opus 5.5",
            isCustom: false,
            capabilities: getClaudeCatalogModelCapabilities(
              BUNDLED_CLAUDE_MODEL_CATALOG,
              "claude-opus-5-5",
            ),
          },
        ],
      } as unknown as ServerProvider,
    ];
    const launch: { modelSelection?: McpGatewayProfile["modelSelection"] } & typeof command =
      command;
    const resolve = (agent: Partial<McpGatewayProfile>) =>
      resolveThreadCreateProfile(launch, [{ ...profile, ...agent }], providers).modelSelection;
    const claude = resolve({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
    });
    expect(claude?.options).toEqual([{ id: "effort", value: "high" }]);
    expect(compileClaudeModelSelection(claude!).effort).toBe("high");
    for (const [instanceId, id] of [
      ["antigravity", "thought_level"],
      ["codex", "reasoningEffort"],
    ]) {
      expect(
        resolve({
          modelSelection: {
            instanceId: ProviderInstanceId.make(instanceId!),
            model: `${instanceId}-model`,
          },
        })?.options,
      ).toEqual([{ id, value: "high" }]);
    }
    expect(
      resolve({
        modelSelection: undefined,
        providerLabel: "Antigravity",
        modelLabel: "antigravity-model-xhigh",
        reasoningEffort: undefined,
      }),
    ).toEqual({
      instanceId: "antigravity",
      model: "antigravity-model",
      options: [{ id: "thought_level", value: "xhigh" }],
    });
  });
});

describe("agent instruction delivery", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const turn = (ordinal: number, overrides: { status?: "completed" | "rolled_back" } = {}) => ({
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status: overrides.status ?? ("completed" as const),
    providerThreadId,
  });
  const attempt = (ordinal: number, profileContentHash?: string) => ({
    id: RunAttemptId.make(`attempt-${ordinal}`),
    runId: RunId.make(`run-${ordinal}`),
    attemptOrdinal: 1,
    providerThreadId,
    nativeThreadId: "native-1",
    ...(profileContentHash === undefined ? {} : { profileContentHash }),
  });
  const accepted = (ordinal: number, status: "completed" | "failed" = "completed") => ({
    runAttemptId: RunAttemptId.make(`attempt-${ordinal}`),
    status,
  });
  // Every input is durable projection state, so a restarted server decides the same way.
  const base = {
    profileContentHash: "sha256:v1",
    nativeThreadId: "native-1",
    run: { providerThreadId },
    runs: [turn(1), turn(2), turn(3)],
    attempts: [attempt(1, "sha256:v1"), attempt(2)],
    providerTurns: [accepted(1), accepted(2)],
    compactedRunIds: new Set<string>(),
  };

  it("skips instructions the same native conversation already accepted", () => {
    expect(agentInstructionsInContext(base)).toBe(true);
  });

  it.each([
    ["a fresh native session", { nativeThreadId: undefined }],
    ["a different native session", { nativeThreadId: "native-2" }],
    ["another provider thread", { run: { providerThreadId: ProviderThreadId.make("switched") } }],
    ["changed profile content", { profileContentHash: "sha256:v2" }],
    ["a later compaction", { compactedRunIds: new Set(["run-2"]) }],
    ["a compaction during the delivering turn", { compactedRunIds: new Set(["run-1"]) }],
    ["a rolled-back delivery", { runs: [turn(1, { status: "rolled_back" }), turn(2), turn(3)] }],
    ["a turn the provider failed", { providerTurns: [accepted(1, "failed"), accepted(2)] }],
  ])("resends instructions after %s", (_label, overrides) => {
    expect(agentInstructionsInContext({ ...base, ...overrides })).toBe(false);
  });

  it("resends when a newer delivery replaced the current content", () => {
    expect(
      agentInstructionsInContext({
        ...base,
        attempts: [attempt(1, "sha256:v1"), attempt(2, "sha256:v2")],
      }),
    ).toBe(false);
  });

  it("ignores a compaction that the delivery came after", () => {
    expect(
      agentInstructionsInContext({
        ...base,
        attempts: [attempt(1), attempt(2, "sha256:v1")],
        compactedRunIds: new Set(["run-1"]),
      }),
    ).toBe(true);
  });
});
