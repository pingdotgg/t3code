/**
 * OpenCode 2 through the whole orchestrator, against a replayed HTTP server:
 * the transcript fixes the order of every request the adapter sends, so a
 * request the orchestrator never lets it make fails the run.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  ProjectId,
  ProviderInstanceId,
  type ProviderReplayEntry,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OPENCODE_2_FULL_ACCESS_ONLY } from "./Adapters/OpenCode2AdapterV2.ts";
import {
  OPENCODE2_HTTP_PROTOCOL,
  OpenCode2OrchestratorReplayHarness,
} from "./Adapters/OpenCode2AdapterV2.testkit.ts";
import { OPENCODE_PROVIDER } from "./Adapters/OpenCodeAdapterV2.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import type { OrchestratorV2ScenarioStep } from "./testkit/OrchestratorScenario.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
const instanceId = ProviderInstanceId.make("opencode");
const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
const mimo: ModelSelection = { instanceId, model: "opencode/mimo-v2.6-flash-free" };

const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
const event = (type: string, data: Record<string, unknown>): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    type: "sdk.event",
    event: { id: `evt_${type.replaceAll(".", "")}`, created: 1, type, data },
  },
});
const sessionInfo = (directory: string) => ({
  data: {
    id: SESSION,
    projectID: "global",
    model: { id: "big-pickle", providerID: "opencode", variant: "default" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1790656601394, updated: 1790656601394 },
    location: { directory },
  },
});
/** One prompt the server accepts and answers with `text`. */
const answeredPrompt = (text: string): ReadonlyArray<ProviderReplayEntry> => [
  out("session.prompt", { sessionID: SESSION, text: "<any>" }),
  reply("session.prompt", {
    data: {
      id: `msg_user_${text}`,
      sessionID: SESSION,
      time: { created: 1790656601410 },
      type: "user",
      payload: { text: "<prompt>" },
      delivery: "steer",
    },
  }),
  event("session.text.ended", {
    sessionID: SESSION,
    assistantMessageID: `msg_assistant_${text}`,
    ordinal: 0,
    text,
  }),
  event("session.execution.succeeded", { sessionID: SESSION }),
];
const createdSession = (directory: string): ReadonlyArray<ProviderReplayEntry> => [
  out("event.subscribe"),
  out("session.create", "<any>"),
  reply("session.create", sessionInfo(directory)),
];

const threadCommands = (input: {
  readonly name: string;
  readonly worktreePath: string;
  readonly runtimeMode?: RuntimeMode;
}) => {
  const threadId = ThreadId.make(`thread:${input.name}`);
  const command = (key: string) => CommandId.make(`command:${input.name}:${key}`);
  return {
    threadId,
    create: {
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: command("create"),
      threadId,
      projectId: ProjectId.make(`project:${input.name}`),
      title: input.name,
      modelSelection: bigPickle,
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.worktreePath,
    } satisfies OrchestrationV2Command,
    message: (key: string, modelSelection: ModelSelection = bigPickle) =>
      ({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: command(key),
        threadId,
        messageId: MessageId.make(`message:${input.name}:${key}`),
        text: `Reply with exactly: ${key}`,
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      }) satisfies OrchestrationV2Command,
    command,
  };
};

/** Runs `commands` in order, letting the thread go idle after each message. */
const runScenario = (input: {
  readonly name: string;
  readonly threadId: ThreadId;
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
}) =>
  Effect.gen(function* () {
    const transcript = yield* OpenCode2OrchestratorReplayHarness.decodeTranscript({
      provider: OPENCODE_PROVIDER,
      protocol: OPENCODE2_HTTP_PROTOCOL,
      version: "2.0.18",
      scenario: input.name,
      entries: input.entries,
    });
    const steps = input.commands.flatMap((command): Array<OrchestratorV2ScenarioStep> => [
      { type: "dispatch", command },
      { type: "advance_clock", duration: "1 millis" },
      ...(command.type === "message.dispatch"
        ? [{ type: "await_thread_idle" as const, threadId: input.threadId }]
        : []),
    ]);
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      { name: input.name, transcript, commands: input.commands, steps },
      OpenCode2OrchestratorReplayHarness,
    ).pipe(provideDeterministicTestRuntime);
    const projection = result.projections.get(input.threadId);
    assert.isDefined(projection);
    return projection;
  });

describe("OpenCode 2 through the orchestrator", () => {
  for (const via of ["message", "thread settings"] as const) {
    it.effect(
      `switches the session's model before the next prompt when changed from the ${via}`,
      () =>
        Effect.gen(function* () {
          const name = `opencode2-model-switch-${via.replace(" ", "-")}`;
          const cwd = yield* checkpointWorkspace(name);
          const thread = threadCommands({ name, worktreePath: cwd });
          const projection = yield* runScenario({
            name,
            threadId: thread.threadId,
            entries: [
              ...createdSession(cwd),
              ...answeredPrompt("FIRST"),
              // The next turn resumes the session at its new selection.
              out("session.get", { sessionID: SESSION }),
              reply("session.get", sessionInfo(cwd)),
              out("session.switchModel", {
                sessionID: SESSION,
                model: { providerID: "opencode", id: "mimo-v2.6-flash-free" },
              }),
              reply("session.switchModel", null),
              ...answeredPrompt("SECOND"),
            ],
            commands: [
              thread.create,
              thread.message("first"),
              ...(via === "thread settings"
                ? [
                    {
                      type: "thread.model-selection.set",
                      commandId: thread.command("model"),
                      threadId: thread.threadId,
                      modelSelection: mimo,
                    } satisfies OrchestrationV2Command,
                  ]
                : []),
              thread.message("second", mimo),
            ],
          });
          assert.deepEqual(
            projection.runs.map((run) => [run.status, run.modelSelection.model]),
            [
              ["completed", bigPickle.model],
              ["completed", mimo.model],
            ],
          );
          // One native session carried both turns.
          assert.lengthOf(projection.providerThreads, 1);
        }).pipe(Effect.scoped),
    );
  }

  it.effect("moves the session to the thread's new worktree before the next prompt", () =>
    Effect.gen(function* () {
      const name = "opencode2-worktree-move";
      const before = yield* checkpointWorkspace(`${name}-before`);
      const after = yield* checkpointWorkspace(`${name}-after`);
      const thread = threadCommands({ name, worktreePath: before });
      const projection = yield* runScenario({
        name,
        threadId: thread.threadId,
        entries: [
          ...createdSession(before),
          ...answeredPrompt("FIRST"),
          out("session.get", { sessionID: SESSION }),
          reply("session.get", sessionInfo(before)),
          out("session.move", { sessionID: SESSION, directory: after }),
          reply("session.move", null),
          ...answeredPrompt("SECOND"),
        ],
        commands: [
          thread.create,
          thread.message("first"),
          {
            type: "thread.metadata.update",
            commandId: thread.command("worktree"),
            threadId: thread.threadId,
            worktreePath: after,
          },
          thread.message("second"),
        ],
      });
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed"],
      );
      assert.lengthOf(projection.providerThreads, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("fails a turn outside Full access with the refusal, never prompting", () =>
    Effect.gen(function* () {
      const name = "opencode2-supervised-refusal";
      const cwd = yield* checkpointWorkspace(name);
      const thread = threadCommands({ name, worktreePath: cwd, runtimeMode: "approval-required" });
      const projection = yield* runScenario({
        name,
        threadId: thread.threadId,
        // The session is created, then the turn is refused: no prompt is expected.
        entries: createdSession(cwd),
        commands: [thread.create, thread.message("refused")],
      });
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["failed"],
      );
      const failure = projection.turnItems.find((item) => item.type === "error");
      assert.equal(
        failure?.type === "error" ? failure.failure.message : undefined,
        OPENCODE_2_FULL_ACCESS_ONLY,
      );
    }).pipe(Effect.scoped),
  );
});
