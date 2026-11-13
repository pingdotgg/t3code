import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type ProviderReplayEntry,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OPENCODE2_HTTP_PROTOCOL,
  OpenCode2OrchestratorReplayHarness,
} from "./Adapters/OpenCode2AdapterV2.testkit.ts";
import { OPENCODE_PROVIDER } from "@t3tools/provider-opencode/testing";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import type { OrchestratorV2ScenarioStep } from "./testkit/OrchestratorScenario.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { BACKGROUND_CHILD, BACKGROUND_HOLD, BACKGROUND_PARENT, BACKGROUND_PROMPT, FIRST_TURN_END, SESSION, agentList, answeredPrompt, autoEditRules, bigPickle, createdSession, event, instructionsWritten, labelled, mimo, out, planRules, reply, sessionInfo, t3Rules, threadCommands, withDirectory } from "./OpenCode2OrchestratorV2.integration-01-opencode-2-through-the-orchestrator-part2.testkit.ts";

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
  it.effect.each(["message", "thread settings"] as const)(
    "switches the session's model before the next prompt when changed from the %s",
    (via) =>
      Effect.gen(function* () {
        const name = `opencode2-model-switch-${via.replace(" ", "-")}`;
        const cwd = yield* checkpointWorkspace(name);
        const thread = threadCommands({ name, worktreePath: cwd });
        const projection = yield* runScenario({
          name,
          threadId: thread.threadId,
          entries: [
            ...createdSession(cwd, name),
            ...instructionsWritten,
            ...answeredPrompt("FIRST"),

            out("session.get", { sessionID: SESSION }),
            reply("session.get", sessionInfo(cwd, t3Rules(name), name)),
            out("session.switchModel", {
              sessionID: SESSION,
              model: { providerID: "opencode", id: "mimo-v2.6-flash-free" },
            }),
            reply("session.switchModel", null),

            ...instructionsWritten,
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

        assert.lengthOf(projection.providerThreads, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("rewrites the session's rules when the thread's mode changes between turns", () =>
    Effect.gen(function* () {
      const name = "opencode2-mode-change";
      const cwd = yield* checkpointWorkspace(name);
      const thread = threadCommands({ name, worktreePath: cwd });
      const setMode = (key: string, runtimeMode: RuntimeMode) =>
        ({
          type: "thread.runtime-mode.set",
          commandId: thread.command(key),
          threadId: thread.threadId,
          runtimeMode,
        }) satisfies OrchestrationV2Command;
      const projection = yield* runScenario({
        name,
        threadId: thread.threadId,
        entries: [
          ...createdSession(cwd, name),
          ...instructionsWritten,
          ...answeredPrompt("FIRST"),

          out("session.get", { sessionID: SESSION }),
          reply("session.get", sessionInfo(cwd, t3Rules(name), name)),
          out("agent.list", "<any>"),
          reply("agent.list", agentList(cwd)),
          out("session.update", { sessionID: SESSION, permissions: autoEditRules(name) }),
          reply("session.update", null),
          ...answeredPrompt("SECOND"),

          out("session.get", { sessionID: SESSION }),
          reply("session.get", sessionInfo(cwd, autoEditRules(name), name)),
          out("session.update", { sessionID: SESSION, permissions: t3Rules(name) }),
          reply("session.update", null),
          ...answeredPrompt("THIRD"),
        ],
        commands: [
          thread.create,
          thread.message("first"),
          setMode("auto-edit", "auto-accept-edits"),
          thread.message("second"),
          setMode("full", "full-access"),
          thread.message("third"),
        ],
      });
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed", "completed"],
      );
      assert.lengthOf(projection.providerThreads, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("denies edits outside the plan directory in plan mode and lifts it after", () =>
    Effect.gen(function* () {
      const name = "opencode2-plan-rules";
      const cwd = yield* checkpointWorkspace(name);
      const thread = threadCommands({ name, worktreePath: cwd, interactionMode: "plan" });
      const projection = yield* runScenario({
        name,
        threadId: thread.threadId,
        entries: [
          ...createdSession(cwd, name, planRules(name), true),

          out("session.switchAgent", { sessionID: SESSION, agent: "plan" }),
          reply("session.switchAgent", null),
          ...instructionsWritten,
          ...answeredPrompt("PLANNED"),
          out("session.get", { sessionID: SESSION }),
          reply("session.get", sessionInfo(cwd, planRules(name), name)),
          out("session.update", { sessionID: SESSION, permissions: t3Rules(name) }),
          reply("session.update", null),
          out("session.switchAgent", { sessionID: SESSION, agent: "build" }),
          reply("session.switchAgent", null),
          ...answeredPrompt("BUILT"),
        ],
        commands: [
          thread.create,
          thread.message("plan"),
          {
            type: "thread.interaction-mode.set",
            commandId: thread.command("default"),
            threadId: thread.threadId,
            interactionMode: "default",
          },
          thread.message("build"),
        ],
      });
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("forks from an earlier turn before the next turn's user message", () =>
    Effect.gen(function* () {
      const name = "opencode2-fork";
      const cwd = yield* checkpointWorkspace(name);
      const recorded = yield* readProviderReplayTranscript(
        new URL("./testkit/fixtures/opencode2_fork/opencode_transcript.ndjson", import.meta.url),
      );

      const transcript = yield* OpenCode2OrchestratorReplayHarness.decodeTranscript(
        withDirectory(recorded, cwd),
      );
      const source = threadCommands({ name, worktreePath: cwd });
      const target = ThreadId.make(`thread:${name}:target`);
      const [one, two] = [source.message("one"), source.message("two")];
      const commands: ReadonlyArray<OrchestrationV2Command> = [
        source.create,
        one,
        two,
        {
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: source.command("fork"),
          sourceThreadId: source.threadId,
          targetThreadId: target,
          sourcePoint: {
            type: "run",
            runId: (yield* IdAllocator.IdAllocatorV2).derive.run({
              threadId: source.threadId,
              ordinal: 1,
            }),
          },
        },
        {
          ...source.message("repeat"),
          threadId: target,
          messageId: MessageId.make(`message:${name}:repeat`),
        },
      ];
      const steps: Array<OrchestratorV2ScenarioStep> = commands.flatMap((command) => [
        { type: "dispatch" as const, command },
        { type: "advance_clock" as const, duration: "1 millis" as const },
        ...(command.type === "message.dispatch"
          ? [{ type: "await_thread_idle" as const, threadId: command.threadId }]
          : []),
      ]);
      const result = yield* runOrchestratorV2ProviderReplayScenario(
        { name, transcript, commands, steps, projectionThreadIds: [source.threadId, target] },
        OpenCode2OrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);
      const forked = result.projections.get(target);
      assert.isDefined(forked);
      assert.equal(forked.contextTransfers[0]?.resolution?.strategy, "native_fork");
      assert.equal(
        forked.providerThreads[0]?.nativeThreadRef?.nativeId,
        recorded.metadata?.["forkedNativeSessionId"],
      );

      assert.deepEqual(
        forked.runs.map((run) => run.status),
        ["completed"],
      );
      const visible = forked.visibleTurnItems.flatMap((row) =>
        row.item.type === "assistant_message" ? [row.item.text] : [],
      );
      assert.deepEqual(visible, ["ONE", "ONE"]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect("never sends OpenCode a queued message that was cancelled", () =>
    Effect.gen(function* () {
      const name = "opencode2-queued-cancel";
      const cwd = yield* checkpointWorkspace(name);
      const thread = threadCommands({ name, worktreePath: cwd });
      const queued = (key: string): OrchestrationV2Command => ({
        ...thread.message(key),
        dispatchMode: { type: "queue_after_active" },
      });
      const ids = yield* IdAllocator.IdAllocatorV2;
      const run = (ordinal: number) => ids.derive.run({ threadId: thread.threadId, ordinal });

      const [first, second, third] = [thread.message("first"), queued("second"), queued("third")];
      const cancel: OrchestrationV2Command = {
        type: "queued-run.cancel",
        commandId: thread.command("cancel"),
        threadId: thread.threadId,
        runId: run(2),
      };
      const transcript = yield* OpenCode2OrchestratorReplayHarness.decodeTranscript({
        provider: OPENCODE_PROVIDER,
        protocol: OPENCODE2_HTTP_PROTOCOL,
        version: "2.0.18",
        scenario: name,
        entries: [
          ...createdSession(cwd, name),
          ...instructionsWritten,
          out("session.prompt", { sessionID: SESSION, id: "<any>", text: "<any>" }),
          reply("session.prompt", {
            data: {
              id: "msg_user_FIRST",
              sessionID: SESSION,
              time: { created: 1 },
              type: "user",
              payload: { text: "<prompt>" },
              delivery: "steer",
            },
          }),

          ...answeredPrompt("THIRD"),
        ],
      });
      const steps: Array<OrchestratorV2ScenarioStep> = [
        { type: "dispatch", command: thread.create },
        { type: "advance_clock", duration: "1 millis" },
        { type: "dispatch", command: first, await: false, key: "first" },
        { type: "await_run_steerable", threadId: thread.threadId, runId: run(1) },
        { type: "dispatch", command: second },
        { type: "dispatch", command: third },
        { type: "dispatch", command: cancel },
        { type: "await_run_status", threadId: thread.threadId, runId: run(2), status: "cancelled" },
        { type: "release_replay_gate", label: FIRST_TURN_END },
        { type: "await", key: "first" },
        { type: "await_thread_idle", threadId: thread.threadId },
      ];
      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name,
          transcript: {
            ...transcript,
            entries: [
              ...transcript.entries.slice(0, -4),
              labelled(
                event("session.execution.succeeded", { sessionID: SESSION }),
                FIRST_TURN_END,
              ),
              ...transcript.entries.slice(-4),
            ],
          },
          commands: [thread.create, first, second, third, cancel],
          steps,
        },
        OpenCode2OrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);
      const projection = result.projections.get(thread.threadId);
      assert.isDefined(projection);
      assert.deepEqual(
        projection.runs.map((candidate) => candidate.status),
        ["completed", "cancelled", "completed"],
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  const backgroundReconnect = Effect.fn("backgroundReconnect")(function* (input: {
    readonly name: string;
    readonly cut: string;
    readonly hold?: string;
    readonly reconnect: (parent: string) => ReadonlyArray<ProviderReplayEntry>;
    readonly steps: (
      thread: ReturnType<typeof threadCommands>,
      run: (ordinal: number) => OrchestrationV2Run["id"],
    ) => ReadonlyArray<OrchestratorV2ScenarioStep>;
    readonly commands: (
      thread: ReturnType<typeof threadCommands>,
    ) => ReadonlyArray<OrchestrationV2Command>;
  }) {
    const cwd = yield* checkpointWorkspace(input.name);
    const recorded = yield* readProviderReplayTranscript(
      new URL(
        "./testkit/fixtures/opencode2_background/opencode_transcript.ndjson",
        import.meta.url,
      ),
    );
    const cut = recorded.entries.findIndex(
      (entry) => entry.type !== "runtime_exit" && entry.label === input.cut,
    );
    assert.isAtLeast(cut, 0);
    const kept = recorded.entries
      .slice(0, cut)
      .map((entry) =>
        entry.type !== "runtime_exit" && entry.label === input.hold
          ? labelled(entry, BACKGROUND_HOLD)
          : entry,
      );
    const transcript = yield* OpenCode2OrchestratorReplayHarness.decodeTranscript({
      ...recorded,
      scenario: input.name,
      entries: [
        ...kept,
        { type: "runtime_exit", status: "success" },
        ...input.reconnect(BACKGROUND_PARENT),
      ],
    });
    const thread = threadCommands({ name: input.name, worktreePath: cwd });
    const ids = yield* IdAllocator.IdAllocatorV2;
    const run = (ordinal: number) => ids.derive.run({ threadId: thread.threadId, ordinal });
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: input.name,
        transcript,
        commands: input.commands(thread),
        steps: input.steps(thread, run),
      },
      OpenCode2OrchestratorReplayHarness,

      { runContinuationWorker: true },
    ).pipe(provideDeterministicTestRuntime);
    const projection = result.projections.get(thread.threadId);
    assert.isDefined(projection);
    return { result, projection };
  });

  it.effect("backfills a follow-up whose stream dropped mid-run and ends it completed", () =>
    Effect.gen(function* () {
      const { result, projection } = yield* backgroundReconnect({
        name: "opencode2-follow-up-reconnect",

        cut: "session.step.streamed.5",
        hold: "session.text.ended.3",
        reconnect: (parent) => [
          out("event.subscribe"),
          out("session.active"),
          reply("session.active", { data: {} }),

          out("message.list", { sessionID: parent, order: "desc", limit: "50" }),
          reply("message.list", {
            data: [
              {
                id: "msg_0eb7a99c0001idleFollowUp00",
                time: { created: 5 },
                type: "idle",
                outcome: "succeeded",
              },
              {
                id: "msg_0eb7a96bb00170K1f1HJUeBNwF",
                time: { created: 4 },
                type: "assistant",
                agent: "build",
                model: { id: "big-pickle", providerID: "opencode", variant: "default" },
                content: [
                  {
                    type: "text",
                    text: "The background subagent finished and returned `CHILD_OK`.",
                  },
                ],
                finish: "stop",
              },
              {
                id: "msg_0eb7a3aee0015KmTB8XkMDW8iy",
                time: { created: 3 },
                type: "synthetic",
                text: "<subagent>CHILD_OK</subagent>",
              },
              {
                id: "msg_0eb7a3e3c001idleParentTurn0",
                time: { created: 2 },
                type: "idle",
                outcome: "succeeded",
              },
            ],
            cursor: {},
          }),
        ],
        commands: (thread) => [
          thread.create,
          thread.message("start", bigPickle, BACKGROUND_PROMPT),
        ],
        steps: (thread, run) => [
          { type: "dispatch", command: thread.create },
          { type: "advance_clock", duration: "1 millis" },

          {
            type: "dispatch",
            command: thread.message("start", bigPickle, BACKGROUND_PROMPT),
            await: false,
            key: "start",
          },
          { type: "advance_clock", duration: "1 millis" },

          { type: "await_run_steerable", threadId: thread.threadId, runId: run(2) },
          { type: "release_replay_gate", label: BACKGROUND_HOLD },
          {
            type: "await_run_status",
            threadId: thread.threadId,
            runId: run(2),
            status: "completed",
          },
          { type: "await", key: "start" },
          { type: "await_thread_idle", threadId: thread.threadId },
        ],
      });
      assert.deepEqual(
        projection.runs.map((candidate) => candidate.status),
        ["completed", "completed"],
      );
      const followUp = projection.runs[1];
      assert.deepEqual(
        projection.turnItems.flatMap((item) =>
          item.runId === followUp?.id && item.type === "assistant_message" ? [item.text] : [],
        ),
        ["The background subagent finished and returned `CHILD_OK`."],
      );
      const shell = result.shellSnapshot.threads.find((row) => row.id === projection.thread.id);
      assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect(
    "settles a background subagent whose end was lost with the stream, and takes the next turn",
    () =>
      Effect.gen(function* () {
        const { result, projection } = yield* backgroundReconnect({
          name: "opencode2-background-lost",

          cut: "session.step.started.3",
          reconnect: (parent) => [
            out("event.subscribe"),

            out("session.active"),
            reply("session.active", { data: {} }),

            out("message.list", { sessionID: BACKGROUND_CHILD, order: "desc", limit: "50" }),
            reply("message.list", {
              data: [
                {
                  id: "msg_0eb7a99b0001idleChildTurn0",
                  time: { created: 4 },
                  type: "idle",
                  outcome: "succeeded",
                },
                {
                  id: "msg_0eb7a916c001NRJQJ5gwIT0QnU",
                  time: { created: 3 },
                  type: "assistant",
                  agent: "general",
                  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
                  content: [{ type: "text", text: "CHILD_OK" }],
                  finish: "stop",
                },
                {
                  id: "msg_0eb7a3aea001Lw1Pav5d4akfEg",
                  time: { created: 2 },
                  type: "user",
                  text: "Run the shell command `sleep 20` with the bash tool and then reply exactly CHILD_OK.",
                },
              ],
              cursor: {},
            }),
            out("session.prompt", { sessionID: parent, id: "<any>", text: "<any>" }),
            reply("session.prompt", {
              data: {
                id: "msg_next",
                sessionID: parent,
                time: { created: 9 },
                type: "user",
                payload: { text: "<prompt>" },
                delivery: "steer",
              },
            }),
            event("session.execution.started", { sessionID: parent }),
            event("session.text.ended", {
              sessionID: parent,
              assistantMessageID: "msg_next_reply",
              ordinal: 0,
              text: "NEXT",
            }),
            event("session.execution.succeeded", { sessionID: parent }),
          ],
          commands: (thread) => [
            thread.create,
            thread.message("start", bigPickle, BACKGROUND_PROMPT),
            thread.message("next"),
          ],
          steps: (thread, run) => [
            { type: "dispatch", command: thread.create },
            { type: "advance_clock", duration: "1 millis" },
            { type: "dispatch", command: thread.message("start", bigPickle, BACKGROUND_PROMPT) },
            { type: "advance_clock", duration: "1 millis" },
            { type: "await_thread_idle", threadId: thread.threadId },
            { type: "dispatch", command: thread.message("next") },
            { type: "advance_clock", duration: "1 millis" },
            {
              type: "await_run_status",
              threadId: thread.threadId,
              runId: run(2),
              status: "completed",
            },
            { type: "await_thread_idle", threadId: thread.threadId },
          ],
        });

        assert.deepEqual(
          projection.runs.map((candidate) => candidate.status),
          ["completed", "completed"],
        );
        assert.lengthOf(projection.subagents, 1);
        assert.deepInclude(projection.subagents[0], { status: "interrupted" });
        assert.include(projection.subagents[0]?.result ?? "", "lost its connection to OpenCode");
        assert.isFalse(
          projection.turnItems.some(
            (item) => item.status === "running" || item.status === "waiting",
          ),
        );
        const shell = result.shellSnapshot.threads.find((row) => row.id === projection.thread.id);
        assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect(
    "settles a background subagent whose report OpenCode delivers into the launching turn",
    () =>
      Effect.gen(function* () {
        // OpenCode 2.0.18 can deliver a child report into the parent's still-running execution, which then answers it.

        const cwd = yield* checkpointWorkspace("opencode2-background-in-turn");
        const recorded = yield* readProviderReplayTranscript(
          new URL(
            "./testkit/fixtures/opencode2_background/opencode_transcript.ndjson",
            import.meta.url,
          ),
        );
        const byLabel = (label: string) => {
          const entry = recorded.entries.find(
            (candidate) => candidate.type !== "runtime_exit" && candidate.label === label,
          );
          assert.isDefined(entry);
          return entry!;
        };
        const parentEnd = recorded.entries.findIndex(
          (entry) => entry.type !== "runtime_exit" && entry.label === "session.execution.succeeded",
        );
        const childStart = recorded.entries.findIndex(
          (entry) => entry.type !== "runtime_exit" && entry.label === "session.step.started.3",
        );
        const transcript = yield* OpenCode2OrchestratorReplayHarness.decodeTranscript({
          ...recorded,
          scenario: "opencode2-background-in-turn",
          entries: [
            ...recorded.entries.slice(0, parentEnd),

            ...recorded.entries.slice(
              childStart,
              recorded.entries.indexOf(byLabel("session.inbox.enqueued.3")),
            ),

            byLabel("session.inbox.enqueued.3"),
            byLabel("session.inbox.delivered.3"),

            byLabel("session.text.ended.3"),
            byLabel("session.execution.succeeded.3"),
          ],
        });
        const thread = threadCommands({ name: "opencode2-background-in-turn", worktreePath: cwd });
        const ids = yield* IdAllocator.IdAllocatorV2;
        const result = yield* runOrchestratorV2ProviderReplayScenario(
          {
            name: "opencode2-background-in-turn",
            transcript,
            commands: [thread.create, thread.message("start", bigPickle, BACKGROUND_PROMPT)],
            steps: [
              { type: "dispatch", command: thread.create },
              { type: "advance_clock", duration: "1 millis" },
              { type: "dispatch", command: thread.message("start", bigPickle, BACKGROUND_PROMPT) },
              { type: "advance_clock", duration: "1 millis" },
              {
                type: "await_run_status",
                threadId: thread.threadId,
                runId: ids.derive.run({ threadId: thread.threadId, ordinal: 1 }),
                status: "completed",
              },
              { type: "await_thread_idle", threadId: thread.threadId },
            ],
          },
          OpenCode2OrchestratorReplayHarness,
          { runContinuationWorker: true },
        ).pipe(provideDeterministicTestRuntime);
        const projection = result.projections.get(thread.threadId);
        assert.isDefined(projection);

        assert.deepEqual(
          projection!.runs.map((candidate) => candidate.status),
          ["completed"],
        );
        assert.lengthOf(projection!.subagents, 1);
        assert.deepInclude(projection!.subagents[0], { status: "completed" });
        assert.include(projection!.subagents[0]?.result ?? "", "CHILD_OK");
        assert.isTrue(
          projection!.turnItems.some(
            (item) =>
              item.type === "assistant_message" && item.text.includes("finished and returned"),
          ),
        );
        assert.isFalse(
          projection!.turnItems.some(
            (item) => item.status === "running" || item.status === "waiting",
          ),
        );
        const shell = result.shellSnapshot.threads.find((row) => row.id === projection!.thread.id);
        assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );
});

