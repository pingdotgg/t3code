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

import { compactBeforeSendTokens, hasInterveningRunWithoutUsage } from "./contextWindow.ts";
import type { ThreadStructure } from "./models.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const claudeWork = ProviderInstanceId.make("claude_work");
const claudeOtherHome = ProviderInstanceId.make("claude_other_home");
const antigravity = ProviderInstanceId.make("antigravity");
const codex = ProviderInstanceId.make("codex");
const lastTurnAt = "2026-10-30T14:23:02.000Z";
const returnedAt = "2026-10-30T23:03:21.000Z";

function sendInput(
  overrides: {
    readonly usedTokens?: number;
    readonly promptCacheTtlMs?: number;
    readonly promptCacheExpiresAt?: string;
    readonly omitTurnTokenUsage?: boolean;
    readonly threadContextUsage?: {
      readonly usedTokens: number;
      readonly maxTokens?: number;
      readonly updatedAt?: string;
      readonly providerThreadUpdatedAt?: string;
    };
    readonly model?: string;
    readonly sourceModel?: string;
    readonly now?: string;
    readonly settings?: Partial<ServerSettings>;
    readonly source?: ProviderInstanceId;
    readonly selected?: ProviderInstanceId;
    readonly onlyEarlierConversationUsage?: boolean;
    readonly unstartedFork?: boolean;
    readonly slashCommands?: ReadonlyArray<string>;
    readonly dismissed?: boolean;
    readonly heldQueue?: boolean;
    readonly pendingRequest?: boolean;
    readonly onlyCompactMessages?: boolean;
    readonly promptOutsideWindow?: boolean;
    readonly text?: string;
    readonly threadIdle?: boolean;
    readonly laterRunWithoutUsage?: { readonly startedAt?: string };
  } = {},
) {
  const source = overrides.source ?? claude;
  const defaultModelFor = (instanceId: ProviderInstanceId) =>
    instanceId === codex
      ? "gpt-5.4"
      : instanceId === antigravity
        ? "gemini-4-neon"
        : "claude-opus-4-6";
  const sourceSelection = {
    instanceId: source,
    model: overrides.sourceModel ?? overrides.model ?? defaultModelFor(source),
  };
  const providers = [
    { instanceId: claude, driver: "claudeAgent", groupKey: "claude:~/.claude" },
    { instanceId: claudeWork, driver: "claudeAgent", groupKey: "claude:~/.claude" },
    { instanceId: claudeOtherHome, driver: "claudeAgent", groupKey: "claude:~/.claude-other" },
    { instanceId: antigravity, driver: "antigravity", groupKey: "antigravity:account-a" },
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
    contextUsage:
      id === "provider-thread-current" && overrides.threadContextUsage !== undefined
        ? {
            usedTokens: overrides.threadContextUsage.usedTokens,
            ...(overrides.threadContextUsage.maxTokens === undefined
              ? {}
              : { maxTokens: overrides.threadContextUsage.maxTokens }),
            ...(overrides.threadContextUsage.updatedAt === undefined
              ? {}
              : { updatedAt: overrides.threadContextUsage.updatedAt }),
          }
        : null,
    updatedAt: DateTime.makeUnsafe(
      overrides.threadContextUsage?.providerThreadUpdatedAt ??
        overrides.threadContextUsage?.updatedAt ??
        lastTurnAt,
    ),
  });
  const visibleTurnItems =
    overrides.promptOutsideWindow === true
      ? [{ item: { type: "assistant_message", text: "Build fixed" } }]
      : [
          {
            item: {
              type: "user_message",
              runId: RunId.make("run-1"),
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
    providerTurns:
      overrides.omitTurnTokenUsage === true
        ? []
        : [
            {
              providerThreadId: ProviderThreadId.make(
                overrides.onlyEarlierConversationUsage === true
                  ? "provider-thread-earlier"
                  : "provider-thread-current",
              ),
              nodeId: "node-1",
              tokenUsage: {
                usedTokens: overrides.usedTokens ?? 293_611,
                updatedAt: lastTurnAt,
                ...(overrides.promptCacheTtlMs === undefined
                  ? {}
                  : { promptCacheTtlMs: overrides.promptCacheTtlMs }),
                ...(overrides.promptCacheExpiresAt === undefined
                  ? {}
                  : { promptCacheExpiresAt: overrides.promptCacheExpiresAt }),
              },
            },
          ],
    runs: [
      {
        id: RunId.make("run-1"),
        ordinal: 1,
        providerInstanceId: source,
        providerThreadId: ProviderThreadId.make("provider-thread-current"),
        rootNodeId: "node-1",
        modelSelection: sourceSelection,
        status: "completed",
        startedAt: "2026-10-30T14:20:00.000Z",
        contextHandoffId: null,
      },
      ...(overrides.laterRunWithoutUsage !== undefined
        ? [
            {
              id: RunId.make("run-2"),
              ordinal: 2,
              providerInstanceId: source,
              providerThreadId: ProviderThreadId.make("provider-thread-current"),
              rootNodeId: "node-2",
              modelSelection: sourceSelection,
              status: "completed",
              startedAt: overrides.laterRunWithoutUsage.startedAt ?? "2026-10-30T14:37:00.000Z",
              contextHandoffId: null,
            },
          ]
        : []),
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
  if (overrides.unstartedFork === true) {
    Object.assign(projection, {
      thread: {
        ...projection.thread,
        activeProviderThreadId: null,
        forkedFrom: { type: "run", threadId: "source-thread", runId: "source-run" },
      },
      runs: [],
      providerThreads: [],
      providerTurns: [],
      contextTransfers: [
        {
          type: "fork",
          targetThreadId: projection.thread.id,
          sourceThreadId: "source-thread",
          sourcePoint: { runId: "source-run" },
          sourceProviderInstanceId: source,
          status: "pending",
          sourceTokenUsage: { usedTokens: 293_611, updatedAt: lastTurnAt },
        },
      ],
    });
  }
  const selected = overrides.selected ?? claude;
  return {
    projection,
    visibleTurnItems: visibleTurnItems as never,
    selection: {
      instanceId: selected,
      model: overrides.model ?? defaultModelFor(selected),
    },
    providers,
    settings: { ...DEFAULT_SERVER_SETTINGS, ...overrides.settings },
    text: overrides.text ?? "back again",
    threadIdle: overrides.threadIdle ?? true,
    now: overrides.now ?? returnedAt,
  };
}

describe("compactBeforeSendTokens", () => {
  it.each([
    { name: "a stale Claude thread over 200K", expected: true },
    {
      name: "when the original prompt is outside the loaded window",
      promptOutsideWindow: true,
      expected: true,
    },
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
      name: "on an Antigravity Gemini thread past its 15m cache TTL",
      source: antigravity,
      selected: antigravity,
      promptCacheTtlMs: 15 * 60_000,
      now: "2026-10-30T14:38:02.000Z",
      expected: true,
    },
    {
      name: "on an Antigravity Gemini thread within its 15m cache TTL",
      source: antigravity,
      selected: antigravity,
      promptCacheTtlMs: 15 * 60_000,
      now: "2026-10-30T14:37:00.000Z",
      expected: false,
    },
    {
      name: "on a pre-TTL Antigravity Gemini thread using the Gemini model fallback",
      source: antigravity,
      selected: antigravity,
      omitTurnTokenUsage: true,
      threadContextUsage: { usedTokens: 293_611 },
      now: "2026-10-30T14:38:02.000Z",
      expected: true,
    },
    {
      name: "on a pre-TTL Antigravity default alias with no live TTL",
      source: antigravity,
      selected: antigravity,
      model: "antigravity-default",
      omitTurnTokenUsage: true,
      threadContextUsage: { usedTokens: 293_611 },
      now: "2026-10-30T14:38:02.000Z",
      expected: false,
    },
    {
      name: "on an Antigravity non-Gemini model with unknown cache TTL",
      source: antigravity,
      selected: antigravity,
      model: "claude-opus-5-5",
      now: "2026-10-30T16:00:00.000Z",
      expected: false,
    },
    {
      name: "when switching from Gemini to Claude on the same Antigravity instance",
      source: antigravity,
      selected: antigravity,
      sourceModel: "gemini-4-neon",
      model: "claude-opus-5-5",
      promptCacheTtlMs: 15 * 60_000,
      now: "2026-10-30T14:38:02.000Z",
      expected: false,
    },
    {
      name: "when switching from a live non-Gemini turn to Gemini on the same Antigravity instance",
      source: antigravity,
      selected: antigravity,
      sourceModel: "claude-opus-5-5",
      model: "gemini-4-neon",
      now: "2026-10-30T14:38:02.000Z",
      expected: false,
    },
    {
      name: "when a post-terminal usage correction lowers Antigravity context below 200K",
      source: antigravity,
      selected: antigravity,
      promptCacheTtlMs: 15 * 60_000,
      threadContextUsage: { usedTokens: 80_000, updatedAt: "2026-10-30T14:23:05.000Z" },
      now: "2026-10-30T14:40:00.000Z",
      expected: false,
    },
    {
      name: "when a later title-only session_info_update follows a post-terminal usage correction",
      source: antigravity,
      selected: antigravity,
      usedTokens: 280_000,
      promptCacheTtlMs: 15 * 60_000,
      threadContextUsage: {
        usedTokens: 293_611,
        updatedAt: "2026-10-30T14:23:05.000Z",
        providerThreadUpdatedAt: "2026-10-30T14:37:00.000Z",
      },
      now: "2026-10-30T14:38:06.000Z",
      expected: true,
    },
    {
      name: "when a newer Antigravity run completed without reporting usage",
      source: antigravity,
      selected: antigravity,
      promptCacheTtlMs: 15 * 60_000,
      laterRunWithoutUsage: { startedAt: "2026-10-30T14:40:00.000Z" },
      now: "2026-10-30T14:41:00.000Z",
      expected: false,
    },
    {
      name: "when a newer Antigravity run completed without usage on a pre-TTL contextUsage thread",
      source: antigravity,
      selected: antigravity,
      omitTurnTokenUsage: true,
      threadContextUsage: {
        usedTokens: 293_611,
        updatedAt: lastTurnAt,
        providerThreadUpdatedAt: "2026-10-30T14:41:00.000Z",
      },
      laterRunWithoutUsage: { startedAt: "2026-10-30T14:40:00.000Z" },
      now: "2026-10-30T14:56:00.000Z",
      expected: false,
    },
    {
      name: "when a pre-TTL contextUsage timestamp equals the later usage-less run start",
      source: antigravity,
      selected: antigravity,
      omitTurnTokenUsage: true,
      threadContextUsage: {
        usedTokens: 293_611,
        updatedAt: "2026-10-30T14:40:00.000Z",
        providerThreadUpdatedAt: "2026-10-30T14:41:00.000Z",
      },
      laterRunWithoutUsage: { startedAt: "2026-10-30T14:40:00.000Z" },
      now: "2026-10-30T14:56:00.000Z",
      expected: false,
    },
    {
      name: "with the Antigravity instance overriding idle compaction to off",
      source: antigravity,
      selected: antigravity,
      promptCacheTtlMs: 15 * 60_000,
      settings: {
        idleCompaction: "onReturn",
        providerInstances: {
          [antigravity]: {
            driver: ProviderDriverKind.make("antigravity"),
            config: { idleCompaction: "off" },
          },
        },
      },
      expected: false,
    },
    {
      name: "on an Antigravity thread after switching to a different Gemini model",
      source: antigravity,
      selected: antigravity,
      sourceModel: "gemini-4-neon",
      model: "gemini-3.1-pro",
      promptCacheTtlMs: 15 * 60_000,
      now: "2026-10-30T14:40:00.000Z",
      expected: false,
    },
    {
      name: "on an Antigravity thread with a newer usage correction keeping the original cache expiry",
      source: antigravity,
      selected: antigravity,
      model: "gemini-4-neon",
      usedTokens: 190_000,
      promptCacheTtlMs: 15 * 60_000,
      promptCacheExpiresAt: "2026-10-30T14:38:02.000Z",
      threadContextUsage: {
        usedTokens: 293_611,
        maxTokens: 1_048_576,
        updatedAt: "2026-10-30T14:24:02.000Z",
      },
      // At 14:38:30 the original 14:38:02 expiry has passed, even though the 14:24:02 correction
      // + 15m would be 14:39:02.
      now: "2026-10-30T14:38:30.000Z",
      expected: true,
    },
    {
      name: "on an Antigravity thread without advertised /compact",
      source: antigravity,
      selected: antigravity,
      promptCacheTtlMs: 15 * 60_000,
      slashCommands: [],
      expected: false,
    },
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
    { name: "an unstarted fork resuming its source instance", unstartedFork: true, expected: true },
    {
      name: "an unstarted fork selecting another Claude home",
      unstartedFork: true,
      selected: claudeOtherHome,
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
    expect(compactBeforeSendTokens(sendInput(overrides as Parameters<typeof sendInput>[0]))).toBe(
      expected ? 293_611 : null,
    );
  });

  it("treats a dated provider-thread usage at or after the latest run start as fresh", () => {
    const thread = {
      id: ProviderThreadId.make("pt-1"),
      contextUsage: { usedTokens: 240_000, updatedAt: "2026-10-30T14:38:00.000Z" },
    };
    const runs = [
      {
        ordinal: 1,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe("2026-10-30T14:20:00.000Z"),
        rootNodeId: "node-1" as never,
        providerThreadId: thread.id,
      },
      {
        ordinal: 2,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe("2026-10-30T14:37:00.000Z"),
        rootNodeId: "node-2" as never,
        providerThreadId: thread.id,
      },
    ];
    const turns = [
      {
        providerThreadId: thread.id,
        nodeId: "node-1" as never,
        tokenUsage: { usedTokens: 210_000, updatedAt: "2026-10-30T14:23:00.000Z" },
      },
    ];
    expect(hasInterveningRunWithoutUsage(runs, turns, thread, "2026-10-30T14:38:00.000Z")).toBe(
      false,
    );
    expect(
      hasInterveningRunWithoutUsage(
        runs,
        turns,
        { ...thread, contextUsage: { usedTokens: 240_000, updatedAt: "2026-10-30T14:36:00.000Z" } },
        "2026-10-30T14:36:00.000Z",
      ),
    ).toBe(true);
  });
});
