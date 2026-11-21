import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  displayStateNote,
  CHAT_REPLIES_DISPLAY_MODE,
  NORMAL_DISPLAY_MODE,
} from "@t3tools/shared/displayModes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as DisplayModeCompactionNote from "./DisplayModeCompactionNote.ts";

const plainId = ThreadId.make("thread:compaction-note:plain");
const chatId = ThreadId.make("thread:compaction-note:chat");
const toldNormalId = ThreadId.make("thread:compaction-note:told-normal");
const unknownToldId = ThreadId.make("thread:compaction-note:unknown-told");
const dashboardId = ThreadId.make("thread:compaction-note:dashboard");

const notes = DisplayModeCompactionNote.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(
    ServerSettings.layerTest({
      threadDisplayModes: { [chatId]: "chat-replies" },
      threadDashboards: { [dashboardId]: true },
    }),
  ),
);

const toldRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly thread_id: string; readonly mode_id: string }>`
    SELECT thread_id, mode_id FROM fork_display_mode_told ORDER BY thread_id
  `;
});

it.layer(notes)("DisplayModeCompactionNote", (it) => {
  it.effect(
    "states the display once a thread has a told record, a non-Normal mode or a Dashboard",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO fork_display_mode_told (thread_id, mode_id)
        VALUES (${toldNormalId}, 'normal'), (${unknownToldId}, 'unknown')`;
        const { noteAfterCompaction } = yield* DisplayModeCompactionNote.DisplayModeCompactionNote;

        assert.isUndefined(yield* noteAfterCompaction(plainId));
        assert.equal(yield* noteAfterCompaction(chatId), CHAT_REPLIES_DISPLAY_MODE.stateNotice);
        assert.equal(yield* noteAfterCompaction(toldNormalId), NORMAL_DISPLAY_MODE.stateNotice);
        assert.equal(yield* noteAfterCompaction(unknownToldId), NORMAL_DISPLAY_MODE.stateNotice);
        assert.equal(
          yield* noteAfterCompaction(dashboardId),
          displayStateNote({ mode: NORMAL_DISPLAY_MODE, dashboard: true }),
        );
        // The next typed message compares with these, so a later switch gets its note.
        assert.deepEqual(
          (yield* toldRows).map((row) => [row.thread_id, row.mode_id]),
          [
            [chatId, "chat-replies@3"],
            [dashboardId, "normal+dashboard@2"],
            [toldNormalId, "normal"],
            [unknownToldId, "normal"],
          ],
        );
      }),
  );

  it.effect("reads whether a thread is in Normal", () =>
    Effect.gen(function* () {
      const { isNormal } = yield* DisplayModeCompactionNote.DisplayModeCompactionNote;
      assert.isTrue(yield* isNormal(plainId));
      assert.isFalse(yield* isNormal(chatId));
    }),
  );
});

it("states the mode instead of announcing a switch", () => {
  for (const mode of [NORMAL_DISPLAY_MODE, CHAT_REPLIES_DISPLAY_MODE]) {
    assert.match(mode.stateNotice, /^<t3-display-mode>This thread is in .*<\/t3-display-mode>$/);
    assert.notInclude(mode.stateNotice, "switched");
  }
});

it("adds the compaction note hook to Claude beside the subagent hook", async () => {
  const threadId = ThreadId.make("thread:compaction-note:claude");
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
      model: "claude-sonnet-4-6",
    },
    nativeThreadId: "native-thread-compaction-note",
    resume: false,
    cwd: "/workspace",
    mcpServers: {},
    deviceToolsAvailable: true,
    hooks: DisplayModeCompactionNote.claudeDisplayModeHooks({
      notes: {
        noteAfterCompaction: (id) =>
          Effect.succeed(id === threadId ? CHAT_REPLIES_DISPLAY_MODE.stateNotice : undefined),
        isNormal: () => Effect.succeed(true),
      },
      threadId,
      activeTurn: Effect.undefined,
      runPromise: Effect.runPromise,
    }),
  });
  assert.lengthOf(options.hooks?.SubagentStart ?? [], 1);
  const [compact] = options.hooks?.SessionStart ?? [];
  assert.equal(compact?.matcher, "compact");
  const callback = compact!.hooks[0]!;
  const input = {
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "native-thread-compaction-note",
    transcript_path: "/transcripts/native-thread-compaction-note.jsonl",
    cwd: "/workspace",
  } satisfies HookInput;
  const signal = new AbortController().signal;

  assert.deepEqual(await callback(input, undefined, { signal }), {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: CHAT_REPLIES_DISPLAY_MODE.stateNotice,
    },
  });
  assert.deepEqual(await callback({ ...input, agent_id: "subagent-1" }, undefined, { signal }), {});
});

it("gives upstream's send_to_user section once in Normal, again after another mode or a compaction", async () => {
  const threadId = ThreadId.make("thread:compaction-note:section");
  let normal: boolean | undefined = true;
  const hooks = DisplayModeCompactionNote.claudeDisplayModeHooks({
    notes: {
      noteAfterCompaction: () => Effect.undefined,
      isNormal: () => Effect.succeed(normal),
    },
    threadId,
    activeTurn: Effect.undefined,
    runPromise: Effect.runPromise,
    sendToUserSection: "SECTION",
  });
  const prompt = hooks.UserPromptSubmit![0]!.hooks[0]!;
  const compact = hooks.SessionStart![0]!.hooks[0]!;
  const base = {
    session_id: "native-thread-section",
    transcript_path: "/transcripts/native-thread-section.jsonl",
    cwd: "/workspace",
  };
  const signal = new AbortController().signal;
  const submit = async (extra: Partial<HookInput> = {}) => {
    const output = await prompt(
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "Go on.", ...extra } as HookInput,
      undefined,
      { signal },
    );
    return "hookSpecificOutput" in output &&
      output.hookSpecificOutput?.hookEventName === "UserPromptSubmit"
      ? output.hookSpecificOutput.additionalContext
      : undefined;
  };

  assert.isUndefined(await submit({ source: "system" } as Partial<HookInput>));
  assert.isUndefined(await submit({ agent_id: "subagent-1" }));
  assert.equal(await submit(), "SECTION");
  assert.isUndefined(await submit());
  normal = undefined;
  assert.isUndefined(await submit());
  normal = false;
  assert.isUndefined(await submit());
  normal = true;
  assert.equal(await submit(), "SECTION");
  const compacted = await compact(
    { ...base, hook_event_name: "SessionStart", source: "compact" } satisfies HookInput,
    undefined,
    { signal },
  );
  assert.deepEqual(compacted, {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "SECTION" },
  });
  assert.isUndefined(await submit());
});
