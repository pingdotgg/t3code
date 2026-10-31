import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  formatClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import { describe, expect, it } from "vite-plus/test";

import { shouldCompactBeforeSend } from "./contextWindow.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const lastTurnAt = "2026-10-30T14:23:02.000Z";
const returnedAt = "2026-10-30T23:03:21.000Z";

function sendInput(
  overrides: {
    readonly usedTokens?: number;
    readonly promptCacheTtlMs?: number;
    readonly now?: string;
    readonly settings?: Partial<ServerSettings>;
    readonly driver?: string;
    readonly slashCommands?: ReadonlyArray<string>;
    readonly dismissed?: boolean;
    readonly heldQueue?: boolean;
    readonly pendingRequest?: boolean;
    readonly onlyCompactMessages?: boolean;
    readonly text?: string;
    readonly threadIdle?: boolean;
  } = {},
) {
  const projection = {
    ...v2Projection,
    providerTurns: [
      {
        tokenUsage: {
          usedTokens: overrides.usedTokens ?? 293_611,
          updatedAt: lastTurnAt,
          ...(overrides.promptCacheTtlMs === undefined
            ? {}
            : { promptCacheTtlMs: overrides.promptCacheTtlMs }),
        },
      },
    ],
    runs:
      overrides.heldQueue === true ? [{ id: "queued-run", status: "queued", queueHeld: true }] : [],
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
  } as unknown as OrchestrationV2ThreadProjection;
  return {
    projection,
    visibleTurnItems: [
      {
        item: {
          type: "user_message",
          text: overrides.onlyCompactMessages === true ? "/compact" : "Fix the build",
          attachments: [],
        },
      },
    ] as never,
    provider: {
      instanceId: claude,
      driver: ProviderDriverKind.make(overrides.driver ?? "claudeAgent"),
      slashCommands: (overrides.slashCommands ?? ["compact"]).map((name) => ({ name })),
    },
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
    { name: "on a Codex thread", driver: "codex", expected: false },
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
