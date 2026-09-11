import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  isLoopbackRemoteAddress,
  resolveProviderSelection,
  threadBrief,
  threadShelf,
  threadStatus,
  titleFromPrompt,
} from "./mapping.ts";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Dark mode",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: "2026-08-28T11:00:00.000Z",
      startedAt: "2026-08-28T11:00:00.000Z",
      completedAt: "2026-08-28T11:05:00.000Z",
      assistantMessageId: null,
    },
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T11:05:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "ready",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-28T11:05:00.000Z",
    },
    latestUserMessageAt: "2026-08-28T11:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    planProgress: null,
    ...overrides,
  };
}

describe("workspace thread mapping", () => {
  it("classifies working, pending approval, settled, and archived shelves", () => {
    expect(
      threadStatus(
        shell({
          session: {
            ...shell().session!,
            status: "running",
          },
        }),
      ),
    ).toBe("working");
    expect(threadStatus(shell({ hasPendingApprovals: true }))).toBe("pending-approval");
    expect(threadStatus(shell())).toBe("completed");
    expect(
      threadShelf(
        shell({ settledOverride: "settled", settledAt: "2026-08-28T11:06:00.000Z" }),
        NOW,
      ),
    ).toBe("settled");
    expect(threadShelf(shell({ archivedAt: "2026-08-28T11:06:00.000Z" }), NOW)).toBe("archived");
  });

  it("keeps snoozed threads out of the inbox unless they need the user", () => {
    const snoozed = shell({ snoozedUntil: "2026-08-28T18:00:00.000Z" });
    expect(threadShelf(snoozed, NOW)).toBe("snoozed");
    expect(threadShelf(shell({ ...snoozed, hasPendingApprovals: true }), NOW)).toBe("active");
  });

  it("exposes sidebar-facing briefs", () => {
    const brief = threadBrief(
      shell({
        hasPendingUserInput: true,
        planProgress: { step: "Editing settings", completedSteps: 1, totalSteps: 3 },
      }),
      NOW,
    );
    expect(brief.status).toBe("awaiting-input");
    expect(brief.provider).toBe("codex");
    expect(brief.planStep).toBe("Editing settings");
  });
});

describe("titleFromPrompt", () => {
  it("uses the first line and truncates long prompts", () => {
    expect(titleFromPrompt("Add dark mode\n\nMake it match the sidebar.")).toBe("Add dark mode");
    expect(titleFromPrompt("   ")).toBe("New thread");
    expect(titleFromPrompt("x".repeat(80)).endsWith("…")).toBe(true);
  });
});

describe("resolveProviderSelection", () => {
  const providers: ServerProvider[] = [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: "1",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      models: [
        {
          slug: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      enabled: true,
      installed: true,
      version: "1",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      models: [
        {
          slug: "claude-sonnet-5",
          name: "Sonnet",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ];

  it("maps spoken provider names onto enabled instances", () => {
    const claude = resolveProviderSelection({ provider: "claude" }, providers, null);
    expect("error" in claude).toBe(false);
    if (!("error" in claude)) {
      expect(claude.instanceId).toBe("claudeAgent");
      expect(claude.model).toBe("claude-sonnet-5");
    }
  });

  it("uses the project default when nothing is named", () => {
    const selected = resolveProviderSelection({}, providers, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    });
    expect("error" in selected).toBe(false);
    if (!("error" in selected)) {
      expect(selected.instanceId).toBe("codex");
    }
  });
});

describe("isLoopbackRemoteAddress", () => {
  it("accepts IPv4-mapped and IPv6 loopback", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("192.168.1.9")).toBe(false);
  });
});
