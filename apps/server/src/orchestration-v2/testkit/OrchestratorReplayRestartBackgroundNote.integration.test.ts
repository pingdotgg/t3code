import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderReplayEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT } from "./fixtures/claude_background_subagent_after_root/input.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { readProviderReplayTranscript } from "./ReplayTranscriptNdjson.ts";

const SCENARIO = "claude_background_subagent_after_root";
const SESSION_ID = "cca274e4-25ae-4171-b972-bbb31118517e";
const FIRST_AFTER_RESTART = "Is the background subagent done yet?";
const SECOND_AFTER_RESTART = "Thanks. Anything else?";
const NOTE = [
  "Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back:",
  "- subagent: Background subagent test",
].join("\n");

/**
 * The recorded background-subagent session cut by a restart right after the
 * root turn settled: the subagent's frames never arrive. A fresh runtime then
 * resumes the native session; each prompt frame it sends is pinned, so these
 * resumed turns are the provider's view of what T3 told it.
 */
const readRestartTranscript = Effect.fn("readRestartTranscript")(function* (
  resumedPrompts: ReadonlyArray<string>,
) {
  const recorded = yield* readProviderReplayTranscript(
    new URL(`./fixtures/${SCENARIO}/claude_transcript.ndjson`, import.meta.url),
  );
  const rootResult = recorded.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "result",
  );
  // The restarted server resumes the recorded session instead of creating it.
  const queryOpen = recorded.entries[0];
  const openFrame = queryOpen?.type === "expect_outbound" ? queryOpen.frame : undefined;
  const queryOptions: unknown =
    typeof openFrame === "object" && openFrame !== null
      ? Reflect.get(openFrame, "options")
      : undefined;
  if (typeof queryOptions !== "object" || queryOptions === null) {
    throw new Error(`${SCENARIO} must open with a recorded query.open frame.`);
  }
  const { sessionId: _sessionId, ...resumeOptions } = queryOptions as Record<string, unknown>;
  const resumedTurn = (label: string, text: string): ReadonlyArray<ProviderReplayEntry> => [
    {
      type: "expect_outbound",
      label: `prompt.offer:${label}`,
      frame: {
        type: "prompt.offer",
        message: {
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        },
      },
    },
    {
      type: "emit_inbound",
      label: `assistant:${label}`,
      frame: {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          id: `msg_restart_${label}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `REPLY_${label}` }],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
        session_id: SESSION_ID,
        uuid: `restart-assistant-${label}`,
      },
    },
    {
      type: "emit_inbound",
      label: `result:${label}`,
      frame: {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: `REPLY_${label}`,
        stop_reason: "end_turn",
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        session_id: SESSION_ID,
        uuid: `restart-result-${label}`,
      },
    },
  ];
  return yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
    ...recorded,
    entries: [
      ...recorded.entries.slice(0, rootResult + 1),
      // The server dies here, with the background subagent still running.
      { type: "runtime_exit", status: "success" },
      {
        type: "expect_outbound",
        label: "query.open:resume",
        frame: { type: "query.open", options: { ...resumeOptions, resume: SESSION_ID } },
      },
      ...resumedPrompts.flatMap((prompt, index) => resumedTurn(String(index + 1), prompt)),
    ],
  });
});

const runRestart = Effect.fn("runRestart")(function* (input: {
  readonly resumedPrompts: ReadonlyArray<string>;
  readonly userMessagesAfterRestart: ReadonlyArray<string>;
  readonly continueThreadsAfterServerUpdate: boolean;
}) {
  const transcript = yield* readRestartTranscript(input.resumedPrompts);
  const workspace = yield* checkpointWorkspace(SCENARIO);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "t3-orchestration-v2-restart-note-" }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: SCENARIO,
    fixtureInput: {
      steps: [
        { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT },
        ...input.userMessagesAfterRestart.map((text) => ({ type: "message" as const, text })),
      ],
    },
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL_SELECTION,
  });
  // Phase 1 ends once the root run settles; the subagent is still open.
  const firstIdle = materialized.steps.findIndex((step) => step.type === "await_thread_idle");
  const phase1Steps = materialized.steps.slice(0, firstIdle + 1);
  const threadId = materialized.projectionThreadIds[0]!;
  const phase2Steps = [
    // Let recovery's continuation (run 2) finish before the next user message.
    ...(input.continueThreadsAfterServerUpdate
      ? [
          {
            type: "await_run_status" as const,
            threadId,
            runId: (yield* IdAllocatorV2).derive.run({ threadId, ordinal: 2 }),
            status: "completed" as const,
          },
        ]
      : []),
    ...materialized.steps.slice(firstIdle + 1),
  ];
  const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript);
  const databaseLayer = makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const scenario = (name: string, steps: typeof materialized.steps) => ({
    name: `${SCENARIO}:${name}`,
    transcript,
    commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
    steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { cwd: workspace },
  });

  const before = yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(scenario("before-restart", phase1Steps), harness, {
      databaseLayer,
    }),
  );
  const settled = projectionFor(before, SCENARIO);
  assert.equal(settled.runs[0]?.status, "completed");
  assert.equal(settled.subagents[0]?.status, "running");

  const after = yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(scenario("after-restart", phase2Steps), harness, {
      databaseLayer,
      recoverOnStartup: true,
      continueThreadsAfterServerUpdate: input.continueThreadsAfterServerUpdate,
    }),
  );
  // The replay runner rejects any prompt frame that differs from the transcript.
  yield* assertComplete;
  const projection = projectionFor(after, SCENARIO);
  assert.equal(projection.subagents[0]?.status, "cancelled");
  return projection;
});

const userTexts = (projection: ReturnType<typeof projectionFor>) =>
  projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : []));

describe("restart-cancelled background work", () => {
  it.effect("tells the next provider turn once that its background subagent died", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* runRestart({
          // The first turn after the restart carries the note; the second does not.
          resumedPrompts: [
            `${NOTE}\n\nUser message:\n${FIRST_AFTER_RESTART}`,
            SECOND_AFTER_RESTART,
          ],
          userMessagesAfterRestart: [FIRST_AFTER_RESTART, SECOND_AFTER_RESTART],
          continueThreadsAfterServerUpdate: false,
        });
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed", "completed", "completed"],
        );
        assert.isFalse(projection.runs.some((run) => run.restartContinuationOfRunId !== undefined));
        // The note reaches the provider only; the timeline keeps what the user sent.
        assert.deepEqual(userTexts(projection), [
          CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT,
          FIRST_AFTER_RESTART,
          SECOND_AFTER_RESTART,
        ]);
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer)),
      ),
    ),
  );

  it.effect("continues a settled thread with the note when restart continuation is on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* runRestart({
          // Recovery's continuation prompts with the note; the user turn after it does not.
          resumedPrompts: [NOTE, FIRST_AFTER_RESTART],
          userMessagesAfterRestart: [FIRST_AFTER_RESTART],
          continueThreadsAfterServerUpdate: true,
        });
        const [root, continuation, user] = projection.runs;
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed", "completed", "completed"],
        );
        assert.equal(continuation?.restartContinuationOfRunId, root?.id);
        assert.isUndefined(user?.restartContinuationOfRunId);
        assert.deepEqual(userTexts(projection), [
          CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT,
          NOTE,
          FIRST_AFTER_RESTART,
        ]);
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer)),
      ),
    ),
  );
});
