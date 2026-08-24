import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  readCodexThreadSnapshots,
  selectCodexThreadsForRead,
  toPersistedThread,
} from "./CodexThreadDiscovery.ts";

type ReadThread = EffectCodexSchema.V2ThreadReadResponse["thread"];
type ListedThread = EffectCodexSchema.V2ThreadListResponse["data"][number];

function makeReadThread(overrides: Record<string, unknown> = {}): ReadThread {
  return {
    id: "provider-thread-1",
    cwd: "/work/project",
    name: null,
    preview: "Preview title",
    createdAt: 1_777_777_700,
    updatedAt: 1_777_777_760,
    source: "cli",
    status: { type: "idle" },
    threadSource: null,
    cliVersion: "1.2.3",
    modelProvider: "openai",
    gitInfo: null,
    turns: [],
    ...overrides,
  } as unknown as ReadThread;
}

function makeListedThread(id: string, overrides: Record<string, unknown> = {}): ListedThread {
  return {
    ...makeReadThread({ id, turns: undefined }),
    ephemeral: false,
    ...overrides,
  } as unknown as ListedThread;
}

it("maps persisted Codex turns to ordered user and assistant history", () => {
  const thread = {
    id: "provider-thread-1",
    cwd: "/work/project",
    name: null,
    preview: "Investigate the importer\nMore context",
    createdAt: 1_777_777_700,
    updatedAt: 1_777_777_760,
    source: "cli",
    status: { type: "idle" },
    threadSource: null,
    cliVersion: "1.2.3",
    modelProvider: "openai",
    gitInfo: null,
    turns: [
      {
        id: "turn-1",
        startedAt: 1_777_777_710,
        completedAt: 1_777_777_750,
        status: "completed",
        items: [
          {
            id: "user-1",
            type: "userMessage",
            content: [
              { type: "text", text: "Investigate the importer" },
              { type: "localImage", path: "/tmp/screenshot.png" },
            ],
          },
          {
            id: "tool-1",
            type: "commandExecution",
            command: "pwd",
            commandActions: [],
            cwd: "/work/project",
            status: "completed",
          },
          {
            id: "assistant-1",
            type: "agentMessage",
            text: "The importer is ready.",
          },
        ],
      },
    ],
  } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

  expect(toPersistedThread(thread)).toMatchObject({
    providerThreadId: "provider-thread-1",
    cwd: "/work/project",
    title: "Investigate the importer",
    sourceMetadata: { source: "cli", cliVersion: "1.2.3" },
    messages: [
      {
        id: "user-1",
        sourceOrdinal: 0,
        role: "user",
        text: "Investigate the importer",
        turnId: "turn-1",
      },
      {
        id: "assistant-1",
        sourceOrdinal: 1,
        role: "assistant",
        text: "The importer is ready.",
        turnId: "turn-1",
      },
    ],
  });
});

it("prefers a persisted name and falls back when all title text is blank", () => {
  expect(toPersistedThread(makeReadThread({ name: "  Named thread  " })).title).toBe(
    "Named thread",
  );
  expect(toPersistedThread(makeReadThread({ name: " ", preview: "\n" })).title).toBe(
    "Imported Codex thread",
  );
});

it("omits partial and empty messages while applying timestamp fallbacks", () => {
  const persisted = toPersistedThread(
    makeReadThread({
      status: { type: "inProgress" },
      turns: [
        {
          id: "turn-active",
          startedAt: 1_777_777_710,
          completedAt: null,
          status: "inProgress",
          items: [{ id: "active-agent", type: "agentMessage", text: "Partial" }],
        },
        {
          id: "turn-complete",
          startedAt: null,
          completedAt: null,
          status: "completed",
          items: [
            {
              id: "empty-user",
              type: "userMessage",
              content: [{ type: "text", text: "  " }],
            },
            { id: "empty-agent", type: "agentMessage", text: "" },
            { id: "agent", type: "agentMessage", text: "Complete" },
          ],
        },
      ],
    }),
  );

  expect(persisted.messages).toEqual([
    expect.objectContaining({
      id: "agent",
      text: "Complete",
      createdAt: "2026-05-03T03:09:20.000Z",
    }),
  ]);
  expect(persisted.discoveryCursor).toBe("2026-05-03T03:09:20.000Z:inProgress");
});

it("selects only user-visible threads whose discovery cursor changed", () => {
  const unchanged = makeListedThread("unchanged");
  const statusChanged = makeListedThread("status-changed", { status: { type: "idle" } });
  const selected = selectCodexThreadsForRead(
    [
      unchanged,
      statusChanged,
      makeListedThread("new"),
      makeListedThread("ephemeral", { ephemeral: true }),
      makeListedThread("subagent", { source: { subAgent: { threadId: "parent" } } }),
      makeListedThread("memory", { threadSource: "memory_consolidation" }),
      makeListedThread("native"),
    ],
    {
      excludeProviderThreadIds: new Set(["native"]),
      cursorByProviderThreadId: new Map([
        ["unchanged", "2026-05-03T03:09:20.000Z:idle"],
        ["status-changed", "2026-05-03T03:09:20.000Z:active"],
      ]),
    },
  );

  expect(selected.map((thread) => thread.id)).toEqual(["status-changed", "new"]);
});

it.effect("keeps readable threads when a sibling disappears between list and read", () =>
  Effect.gen(function* () {
    const threads = [makeListedThread("deleted"), makeListedThread("healthy")];
    const discovered = yield* readCodexThreadSnapshots(threads, (threadId) =>
      threadId === "deleted"
        ? Effect.fail({ _tag: "ThreadReadFailed" as const })
        : Effect.succeed({
            thread: makeReadThread({ id: threadId, preview: "Healthy thread" }),
          } as EffectCodexSchema.V2ThreadReadResponse),
    );

    expect(discovered.map((thread) => thread.providerThreadId)).toEqual(["healthy"]);
  }),
);
