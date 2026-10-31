import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  formatClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { shouldCompactBeforeSend } from "./contextWindow.ts";
import type { ThreadStructure } from "./models.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const claudeWork = ProviderInstanceId.make("claude_work");
const claudeOtherHome = ProviderInstanceId.make("claude_other_home");
const codex = ProviderInstanceId.make("codex");
const lastTurnAt = "2026-10-30T14:23:02.000Z";
const returnedAt = "2026-10-30T23:03:21.000Z";

function sendInput(
  overrides: {
    readonly usedTokens?: number;
    readonly promptCacheTtlMs?: number;
    readonly now?: string;
    readonly settings?: Partial<ServerSettings>;
    readonly source?: ProviderInstanceId;
    readonly selected?: ProviderInstanceId;
    readonly onlyEarlierConversationUsage?: boolean;
    readonly slashCommands?: ReadonlyArray<string>;
    readonly dismissed?: boolean;
    readonly heldQueue?: boolean;
    readonly pendingRequest?: boolean;
    readonly onlyCompactMessages?: boolean;
    readonly text?: string;
    readonly threadIdle?: boolean;
  } = {},
) {
  const source = overrides.source ?? claude;
  const sourceSelection = {
    instanceId: source,
    model: source === codex ? "gpt-5.4" : "claude-opus-4-6",
  };
  const providers = [
    { instanceId: claude, driver: "claudeAgent", groupKey: "claude:~/.claude" },
    { instanceId: claudeWork, driver: "claudeAgent", groupKey: "claude:~/.claude" },
    { instanceId: claudeOtherHome, driver: "claudeAgent", groupKey: "claude:~/.claude-other" },
    { instanceId: codex, driver: "codex", groupKey: "codex:~/.codex" },
  ].map(({ instanceId, driver, groupKey }) => ({
    instanceId,
    driver: ProviderDriverKind.make(driver),
    continuation: { groupKey },
    slashCommands: (overrides.slashCommands ?? ["compact"]).map((name) => ({ name })),
  })) as unknown as ReadonlyArray<ServerProvider>;
  const providerThread = (id: string) => ({
    id: ProviderThreadId.make(id),
    driver: providers.find((provider) => provider.instanceId === source)!.driver,
    providerInstanceId: source,
    contextUsage: null,
    updatedAt: DateTime.makeUnsafe(lastTurnAt),
  });
  const visibleTurnItems = [
    {
      item: {
        type: "user_message",
        text: overrides.onlyCompactMessages === true ? "/compact" : "Fix the build",
        attachments: [],
      },
    },
  ];
  const projection = {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      providerInstanceId: source,
      modelSelection: sourceSelection,
      activeProviderThreadId: ProviderThreadId.make("provider-thread-current"),
    },
    providerThreads: [
      providerThread("provider-thread-earlier"),
      providerThread("provider-thread-current"),
    ],
    providerTurns: [
      {
        providerThreadId: ProviderThreadId.make(
          overrides.onlyEarlierConversationUsage === true
            ? "provider-thread-earlier"
            : "provider-thread-current",
        ),
        tokenUsage: {
          usedTokens: overrides.usedTokens ?? 293_611,
          updatedAt: lastTurnAt,
          ...(overrides.promptCacheTtlMs === undefined
            ? {}
            : { promptCacheTtlMs: overrides.promptCacheTtlMs }),
        },
      },
    ],
    runs: [
      {
        id: RunId.make("run-1"),
        ordinal: 1,
        providerInstanceId: source,
        modelSelection: sourceSelection,
        status: "completed",
        startedAt: "2026-10-30T14:20:00.000Z",
        contextHandoffId: null,
      },
      ...(overrides.heldQueue === true
        ? [{ id: RunId.make("queued-run"), status: "queued", queueHeld: true, startedAt: null }]
        : []),
    ],
    runtimeRequests: [
      ...(overrides.dismissed === true
        ? [
            {
              kind: "user_input",
              status: "resolved",
              answers: {
                [formatClaudeResumeCompactionQuestion({
                  ageMinutes: 90,
                  estimatedTokens: 250_000,
                })]: CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
              },
            },
          ]
        : []),
      ...(overrides.pendingRequest === true ? [{ kind: "approval", status: "pending" }] : []),
    ],
    visibleTurnItems,
  } as unknown as ThreadStructure;
  const selected = overrides.selected ?? claude;
  return {
    projection,
    visibleTurnItems: visibleTurnItems as never,
    selection: {
      instanceId: selected,
      model: selected === codex ? "gpt-5.4" : "claude-opus-4-6",
    },
    providers,
    settings: { ...DEFAULT_SERVER_SETTINGS, ...overrides.settings },
    text: overrides.text ?? "back again",
    threadIdle: overrides.threadIdle ?? true,
    now: overrides.now ?? returnedAt,
  };
}

describe("shouldCompactBeforeSend", () => {
  it.each([
    { name: "a stale Claude thread over 200K", expected: true },
    {
      name: "when the environment compacts before the cache expires",
      settings: { idleCompaction: "beforeCacheExpires" },
      expected: true,
    },
    {
      name: "past a reported TTL shorter than the fallback",
      promptCacheTtlMs: 5 * 60_000,
      now: "2026-10-30T14:30:00.000Z",
      expected: true,
    },
    { name: "within the fallback TTL", now: "2026-10-30T15:23:02.000Z", expected: false },
    { name: "under 200K", usedTokens: 150_000, expected: false },
    { name: "with idle compaction off", settings: { idleCompaction: "off" }, expected: false },
    {
      name: "with the Claude instance overriding idle compaction to off",
      settings: {
        idleCompaction: "onReturn",
        providerInstances: {
          [claude]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { idleCompaction: "off" },
          },
        },
      },
      expected: false,
    },
    { name: "on a Codex thread", source: codex, selected: codex, expected: false },
    {
      name: "after switching a stale Codex thread to Claude",
      source: codex,
      selected: claude,
      expected: false,
    },
    {
      name: "after switching to a Claude instance that continues the conversation",
      selected: claudeWork,
      expected: true,
    },
    {
      name: "after switching to a Claude instance with another home",
      selected: claudeOtherHome,
      expected: false,
    },
    {
      name: "when only an earlier conversation reported usage",
      onlyEarlierConversationUsage: true,
      expected: false,
    },
    { name: "for a provider without /compact", slashCommands: [], expected: false },
    {
      name: "after Claude's resume dialog was answered Don't ask again",
      dismissed: true,
      expected: false,
    },
    { name: "while the queue is held", heldQueue: true, expected: false },
    { name: "while a request waits for an answer", pendingRequest: true, expected: false },
    { name: "while the thread is working", threadIdle: false, expected: false },
    { name: "with no conversation but /compact", onlyCompactMessages: true, expected: false },
    { name: "for a typed /compact", text: "/compact keep the plan", expected: false },
  ] as const)("$name", ({ name: _name, expected, ...overrides }) => {
    expect(shouldCompactBeforeSend(sendInput(overrides as Parameters<typeof sendInput>[0]))).toBe(
      expected,
    );
  });
});
