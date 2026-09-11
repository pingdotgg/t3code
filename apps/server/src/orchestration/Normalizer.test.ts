import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import {
  canonicalizeClientCommandTimestamps,
  resolveThreadCreateDefaults,
  resolveThreadCreateProfile,
} from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });

  it("resolves a named profile from the authoritative server revision", () => {
    const command = {
      type: "thread.create",
      commandId: CommandId.make("command-profile"),
      threadId: ThreadId.make("thread-profile"),
      projectId: ProjectId.make("project-1"),
      title: "Profile thread",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "override" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      profileSelection: { profileId: "profile-andy", revision: 2, overrideFields: [] },
      branch: null,
      worktreePath: null,
      createdAt: serverReceivedAt,
    } as const;
    const profile = {
      profileId: "profile-andy",
      name: "Andy",
      systemPrompt: "Plan first. Write a plan.md file.",
      revision: 2,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      reasoningEffort: "high",
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
      createdAt: serverReceivedAt,
      updatedAt: serverReceivedAt,
    } as const;

    expect(resolveThreadCreateProfile(command as never, [profile])).toMatchObject({
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
      profileSnapshot: {
        systemPrompt: "Plan first. Write a plan.md file.",
        profileId: "profile-andy",
        profileName: "Andy",
        revision: 2,
        reasoningEffort: "high",
        effectiveSource: {
          modelSelection: "profile",
          runtimeMode: "profile",
          interactionMode: "profile",
          reasoningEffort: "profile",
        },
      },
    });
  });

  it("resolves a readable Settings profile against the live provider catalog", () => {
    const command = {
      type: "thread.create",
      commandId: CommandId.make("command-readable-profile"),
      threadId: ThreadId.make("thread-readable-profile"),
      projectId: ProjectId.make("project-1"),
      title: "Readable profile thread",
      modelSelection: undefined,
      runtimeMode: undefined,
      interactionMode: undefined,
      profileSelection: { profileId: "profile-andy", revision: 2, overrideFields: [] },
      branch: null,
      worktreePath: null,
      createdAt: serverReceivedAt,
    } as const;
    const profile = {
      profileId: "profile-andy",
      name: "Andy",
      revision: 2,
      providerLabel: "Codex",
      modelLabel: "GPT-5.6 Sol",
      reasoningEffort: "high",
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
      createdAt: serverReceivedAt,
      updatedAt: serverReceivedAt,
    } as const;
    const providers = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        status: "ready",
        availability: "available",
        models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
      },
    ] as never;

    expect(resolveThreadCreateProfile(command as never, [profile], providers)).toMatchObject({
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      profileSnapshot: {
        profileId: "profile-andy",
        profileName: "Andy",
        revision: 2,
      },
    });
  });

  it("resolves an exact model slug even when display names collide", () => {
    const command = {
      type: "thread.create",
      commandId: CommandId.make("command-readable-profile"),
      threadId: ThreadId.make("thread-readable-profile"),
      projectId: ProjectId.make("project-1"),
      title: "Readable profile thread",
      modelSelection: undefined,
      runtimeMode: undefined,
      interactionMode: undefined,
      profileSelection: { profileId: "profile-andy", revision: 2, overrideFields: [] },
      branch: null,
      worktreePath: null,
      createdAt: serverReceivedAt,
    } as const;
    const profile = {
      profileId: "profile-andy",
      name: "Andy",
      revision: 2,
      providerLabel: "Codex",
      modelLabel: "gpt-5.6-sol",
      reasoningEffort: "high",
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
      createdAt: serverReceivedAt,
      updatedAt: serverReceivedAt,
    } as const;
    const providers = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        status: "ready",
        availability: "available",
        models: [
          { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { slug: "other-route", name: "GPT-5.6 Sol" },
        ],
      },
    ] as never;

    expect(resolveThreadCreateProfile(command as never, [profile], providers)).toMatchObject({
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      profileSnapshot: {
        profileId: "profile-andy",
        profileName: "Andy",
        revision: 2,
      },
    });
  });

  it("rejects an ambiguous readable profile selection", () => {
    const command = {
      modelSelection: undefined,
      runtimeMode: undefined,
      interactionMode: undefined,
      profileSelection: { profileId: "profile-andy", revision: 2, overrideFields: [] },
    } as const;
    const profile = {
      profileId: "profile-andy",
      name: "Andy",
      revision: 2,
      providerLabel: "Codex",
      modelLabel: "GPT-5.6 Sol",
      runtimeMode: "approval-required",
      interactionMode: "default",
    } as never;
    const duplicateProviders = ["codex-1", "codex-2"].map((instanceId) => ({
      instanceId,
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      status: "ready",
      availability: "available",
      models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
    })) as never;

    expect(() =>
      resolveThreadCreateProfile(command as never, [profile], duplicateProviders),
    ).toThrow(/ambiguous/i);
  });

  it("rejects a stale named profile revision", () => {
    const command = {
      modelSelection: undefined,
      runtimeMode: "approval-required",
      interactionMode: "default",
      profileSelection: { profileId: "profile-andy", revision: 1, overrideFields: [] },
    } as const;
    const profile = {
      profileId: "profile-andy",
      revision: 2,
    };

    expect(() => resolveThreadCreateProfile(command, [profile as never])).toThrow("profile-andy");
  });

  it("prefers the authoritative project default over the provider default", () => {
    const result = resolveThreadCreateDefaults(
      { projectId: "project-1", useServerDefaults: true },
      [
        {
          id: "project-1",
          defaultModelSelection: { instanceId: "claude", model: "project-model" },
        },
      ] as never,
      [
        {
          instanceId: "codex",
          isDefault: true,
          models: [{ slug: "provider-model", isDefault: true }],
        },
      ] as never,
    );

    expect(result.modelSelection).toEqual({ instanceId: "claude", model: "project-model" });
  });

  it("uses the authoritative provider default when the project has none", () => {
    const result = resolveThreadCreateDefaults(
      { projectId: "project-1", useServerDefaults: true },
      [{ id: "project-1", defaultModelSelection: null }] as never,
      [
        {
          instanceId: "codex-default",
          status: "ready",
          disabled: false,
          isDefault: true,
          models: [
            { slug: "other", isDefault: false },
            { slug: "provider-default", isDefault: true },
          ],
        },
      ] as never,
    );

    expect(result.modelSelection).toEqual({
      instanceId: "codex-default",
      model: "provider-default",
    });
  });
});
