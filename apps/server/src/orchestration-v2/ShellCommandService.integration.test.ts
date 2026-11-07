import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ShellCommands from "./ShellCommandService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const makeHarness = Effect.fn("ShellCommandTest.makeHarness")(function* (
  options: {
    respond?: boolean;
    background?: boolean;
    real?: boolean;
    output?: string;
    code?: number;
  } = {},
) {
  const started = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  let spawnCount = 0;
  let stopped = false;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      spawnCount++;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopped = true;
        }),
      );
      yield* Deferred.succeed(started, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(options.output ?? "stdout\n")),
        stderr: Stream.encodeText(Stream.make("stderr\n")),
        all: Stream.empty,
        exitCode: (options.background ? Deferred.await(completed) : Effect.void).pipe(
          Effect.as(ChildProcessSpawner.ExitCode(options.code ?? 0)),
        ),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const providerEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const calls: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId, model: "gpt-5.4" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(providerEvents),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "shell-native", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.sync(() => {
              calls.push(turn);
            }),
          steerTurn: () => Effect.die("Shell text must not be steered"),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const threadId = ThreadId.make("shell-test");
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: "shell-test", runtimePolicyOverride: { cwd: process.cwd() } },
    ProviderAdapterRegistry.layerSingle(adapter),
    {
      runEffectWorker: false,
      runContinuationWorker: true,
      respondToShellCommands: options.respond ?? true,
      ...(options.real ? {} : { shellSpawner: spawner }),
    },
  );
  const create = Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("shell-project"),
      title: "Shell test",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });
  const send = Effect.fn("ShellCommandTest.send")(function* (
    id: string,
    text: string,
    provenance: Partial<
      Pick<OrchestrationV2ConversationMessage, "createdBy" | "creationSource" | "scheduledTaskId">
    > = {},
  ) {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      threadId,
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      ...provenance,
    });
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  });
  const projection = Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  );
  return {
    layer,
    create,
    send,
    projection,
    providerEvents,
    calls,
    started,
    completed,
    threadId,
    spawnCount: () => spawnCount,
    stopped: () => stopped,
  };
});

it.effect(
  "runs once, injects the persisted shell block as the prompt, and marks it delivered",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* h.create;
        yield* h.send("shell", "!printf hello");
        const projection = yield* h.projection;
        const item = projection.turnItems.find(
          (item) => item.type === "command_execution" && item.userShell !== undefined,
        );
        if (item?.type !== "command_execution" || !item.userShell)
          return yield* Effect.die("missing shell result");
        expect(item.userShell?.delivery).toBe("delivered");
        expect(item.output).toContain("stdout\n");
        expect(item.output).toContain("stderr\n");
        expect(item.userShell?.outputFile).toBeUndefined();
        expect(projection.messages.find((message) => message.role === "user")?.text).toBe(
          "!printf hello",
        );
        expect(h.calls.map((call) => call.message.text)).toEqual([
          `The user ran this shell command directly, not through you. Do not re-run it.\n<user_shell_command>\n<command>\nprintf hello\n</command>\n<result>\nCwd: ${process.cwd()}\nExit code: 0\nDuration: 0.0000 seconds\nOutput:\n${item.output}\n</result>\n</user_shell_command>`,
        ]);
        yield* (yield* ShellCommands.ShellCommandService).execute({
          item: { ...item, userShell: item.userShell },
          run: projection.runs[0]!,
          driver: ProviderDriverKind.make("codex"),
        });
        expect(h.spawnCount()).toBe(1);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect(
  "keeps respond-off results pending, excludes dismissed items, and delivers them on the next turn",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ respond: false });
      yield* Effect.gen(function* () {
        yield* h.create;
        yield* h.send("first", "!first");
        yield* h.send("second", "!second");
        expect(h.calls).toHaveLength(0);
        const before = yield* h.projection;
        expect(before.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
        const items = before.turnItems.filter(
          (item) => item.type === "command_execution" && item.userShell !== undefined,
        );
        expect(
          items.map((item) =>
            item.type === "command_execution" ? item.userShell?.delivery : undefined,
          ),
        ).toEqual(["pending", "pending"]);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "shell-command.delivery.set",
          commandId: CommandId.make("dismiss"),
          threadId: h.threadId,
          itemId: items[0]!.id,
          delivery: "dismissed",
        });
        expect(
          yield* orchestrator
            .dispatch({
              type: "shell-command.delivery.set",
              commandId: CommandId.make("dismiss-again"),
              threadId: h.threadId,
              itemId: items[0]!.id,
              delivery: "dismissed",
            })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "OrchestratorDispatchError",
          cause: "Shell delivery can only change between pending and dismissed.",
        });
        yield* h.send("next", "Explain the result");
        expect(h.calls[0]?.message.text).toContain("<command>\nsecond\n</command>");
        expect(h.calls[0]?.message.text).not.toContain("<command>\nfirst\n</command>");
        expect(h.calls[0]?.message.text).toContain("Explain the result");
        const after = yield* h.projection;
        expect(
          after.turnItems
            .filter((item) => item.type === "command_execution" && item.userShell !== undefined)
            .map((item) =>
              item.type === "command_execution" ? item.userShell?.delivery : undefined,
            ),
        ).toEqual(["dismissed", "delivered"]);
        yield* orchestrator.dispatch({
          type: "shell-command.delivery.set",
          commandId: CommandId.make("include"),
          threadId: h.threadId,
          itemId: items[0]!.id,
          delivery: "pending",
        });
        expect(
          (yield* (yield* ShellCommands.ShellCommandService).pending(h.threadId)).map(
            (item) => item.id,
          ),
        ).toEqual([items[0]!.id]);
        for (const [index, delivery] of [
          [0, "pending"],
          [1, "pending"],
          [1, "dismissed"],
        ] as const) {
          expect(
            yield* orchestrator
              .dispatch({
                type: "shell-command.delivery.set",
                commandId: CommandId.make(`reject-${index}-${delivery}`),
                threadId: h.threadId,
                itemId: items[index]!.id,
                delivery,
              })
              .pipe(Effect.flip),
          ).toMatchObject({
            _tag: "OrchestratorDispatchError",
            cause: "Shell delivery can only change between pending and dismissed.",
          });
        }
        expect(
          yield* orchestrator
            .dispatch({
              type: "shell-command.stop",
              commandId: CommandId.make("stop-completed"),
              threadId: h.threadId,
              itemId: items[0]!.id,
            })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "OrchestratorDispatchError",
          cause: "Only running shell commands can be stopped.",
        });
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect.each([
  { createdBy: "agent" as const, creationSource: "mcp" as const },
  {
    createdBy: "user" as const,
    creationSource: "web" as const,
    scheduledTaskId: ScheduledTaskId.make("scheduled"),
  },
])("keeps non-client shell text plain: %j", (provenance) =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* Effect.gen(function* () {
      yield* h.create;
      yield* h.send("plain", "!plain", provenance);
      expect(h.spawnCount()).toBe(0);
      expect(h.calls[0]?.message.text).toBe("!plain");
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect.each([false, true])(
  "background completion wakes only with responding enabled: %s",
  (respond) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ respond, background: true });
      yield* Effect.gen(function* () {
        yield* h.create;
        const running = yield* h.send("background", "!long-running").pipe(Effect.forkScoped);
        yield* Deferred.await(h.started);
        yield* TestClock.adjust(120_000);
        yield* Fiber.join(running);
        const before = yield* h.projection;
        expect(before.runs[0]?.status).toBe("completed");
        expect(h.calls).toHaveLength(0);
        const item = before.turnItems.find(
          (item) => item.type === "command_execution" && item.userShell !== undefined,
        );
        expect(item).toMatchObject({
          status: "running",
          userShell: { backgrounded: true, delivery: "pending" },
        });
        const sink = yield* EventSink.EventSinkV2;
        const afterSequence = yield* sink.latestSequence();
        const finished = yield* sink.stream({ afterSequence }).pipe(
          Stream.map((stored) => stored.event),
          Stream.filter((event) =>
            respond
              ? event.type === "message.updated" && event.payload.creationSource === "server"
              : event.type === "turn-item.updated" &&
                event.payload.id === item?.id &&
                event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.succeed(h.completed, undefined);
        yield* Fiber.join(finished);
        const after = yield* h.projection;
        expect(
          after.messages.some(
            (message) => message.createdBy === "agent" && message.creationSource === "server",
          ),
        ).toBe(respond);
        if (respond) {
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          expect(h.calls).toHaveLength(1);
          expect(h.calls[0]!.message.text).toContain("Exit code: 0");
        }
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect.each([
  "shell-command.stop",
  "run.interrupt",
  "thread.stop",
  "thread.archive",
  "thread.delete",
] as const)("stops background processes through %s", (type) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ respond: false, background: true });
    yield* Effect.gen(function* () {
      yield* h.create;
      const running = yield* h.send("background", "!long-running").pipe(Effect.forkScoped);
      yield* Deferred.await(h.started);
      yield* TestClock.adjust(120_000);
      yield* Fiber.join(running);
      const item = (yield* h.projection).turnItems.find(
        (item) => item.type === "command_execution" && item.userShell !== undefined,
      );
      if (item?.type !== "command_execution" || !item.userShell)
        return yield* Effect.die("missing command");
      const dispatched = yield* (yield* Orchestrator.OrchestratorV2).dispatch(
        type === "shell-command.stop"
          ? { type, commandId: CommandId.make("stop"), threadId: h.threadId, itemId: item.id }
          : type === "run.interrupt"
            ? {
                type,
                commandId: CommandId.make("interrupt"),
                threadId: h.threadId,
                runId: item.runId!,
              }
            : { type, commandId: CommandId.make("cleanup"), threadId: h.threadId },
      );
      if (type === "shell-command.stop") expect(dispatched.storedEvents).toEqual([]);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      expect(h.stopped()).toBe(true);
      if (type === "shell-command.stop" || type === "run.interrupt" || type === "thread.stop") {
        expect(
          (yield* h.projection).turnItems.find((candidate) => candidate.id === item.id),
        ).toMatchObject({
          status: "interrupted",
          userShell: { stoppedByUser: true, delivery: "pending" },
        });
        expect(
          yield* (yield* Orchestrator.OrchestratorV2)
            .dispatch({
              type: "shell-command.stop",
              commandId: CommandId.make("stop-again"),
              threadId: h.threadId,
              itemId: item.id,
            })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "OrchestratorDispatchError",
          cause: "Only running shell commands can be stopped.",
        });
      } else {
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(item.userShell.outputFile!)).toBe(false);
      }
    }).pipe(Effect.provide(Layer.mergeAll(h.layer, NodeServices.layer)));
  }),
);

it.effect.each([false, true])(
  "interrupts background shells with an active run only when holding its queue: %s",
  (holdQueue) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ respond: false, background: true });
      yield* Effect.gen(function* () {
        yield* h.create;
        const running = yield* h.send("background", "!long-running").pipe(Effect.forkScoped);
        yield* Deferred.await(h.started);
        yield* TestClock.adjust(120_000);
        yield* Fiber.join(running);
        const item = (yield* h.projection).turnItems.find(
          (item) => item.type === "command_execution" && item.userShell !== undefined,
        )!;
        yield* h.send("provider", "Continue working");
        const turn = h.calls[0]!;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const afterSequence = yield* sink.latestSequence();
        const accepted = yield* sink.stream({ afterSequence }).pipe(
          Stream.map((stored) => stored.event),
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(h.providerEvents, {
          type: "provider_turn.updated",
          driver: turn.providerThread.driver,
          providerTurn: {
            id: ProviderTurnId.make("provider-turn:active"),
            providerThreadId: turn.providerThread.id,
            nodeId: turn.rootNodeId,
            runAttemptId: turn.attemptId,
            nativeTurnRef: null,
            ordinal: turn.providerTurnOrdinal,
            status: "running",
            startedAt: yield* DateTime.now,
            completedAt: null,
          },
        });
        yield* Fiber.join(accepted);
        const runId = (yield* h.projection).runs.at(-1)!.id;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("interrupt-active"),
          threadId: h.threadId,
          runId,
          holdQueue,
        });
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        const interrupted = yield* h.projection;
        expect(interrupted.runs.at(-1)?.status).toBe("interrupted");
        expect(h.stopped()).toBe(holdQueue);
        expect(interrupted.turnItems.find((candidate) => candidate.id === item.id)).toMatchObject({
          status: holdQueue ? "interrupted" : "running",
          userShell: { backgrounded: true },
        });
        if (!holdQueue) {
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("interrupt-background"),
            threadId: h.threadId,
            runId,
          });
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        }
        expect(h.stopped()).toBe(true);
        expect(
          (yield* h.projection).turnItems.find((candidate) => candidate.id === item.id),
        ).toMatchObject({
          status: "interrupted",
          userShell: { stoppedByUser: true, delivery: "pending" },
        });
      }).pipe(Effect.provide(h.layer));
    }),
);

it.live("executes a real login shell with merged output and no stdin", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ real: true });
    yield* Effect.gen(function* () {
      yield* h.create;
      yield* h.send("real", "!printf out; printf err >&2; read value || printf eof");
      const item = (yield* h.projection).turnItems.find(
        (item) => item.type === "command_execution" && item.userShell !== undefined,
      );
      expect(item).toMatchObject({
        exitCode: 0,
        status: "completed",
        userShell: { delivery: "delivered" },
      });
      if (item?.type === "command_execution") {
        expect(item.output).toContain("out");
        expect(item.output).toContain("err");
        expect(item.output).toContain("eof");
      }
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("interrupts a foreground command without starting a provider turn", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ background: true });
    yield* Effect.gen(function* () {
      yield* h.create;
      const running = yield* h.send("foreground", "!long-running").pipe(Effect.forkScoped);
      yield* Deferred.await(h.started);
      const before = yield* h.projection;
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("interrupt"),
        threadId: h.threadId,
        runId: before.runs[0]!.id,
      });
      yield* Fiber.join(running);
      const after = yield* h.projection;
      expect(h.stopped()).toBe(true);
      expect(h.calls).toHaveLength(0);
      expect(
        after.turnItems.find((item) => item.type === "command_execution" && item.userShell),
      ).toMatchObject({
        status: "interrupted",
        userShell: { delivery: "pending", stoppedByUser: true },
      });
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect.each([0, 1])(
  "retains full output files when persisted output is truncated (exit %s)",
  (code) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ code, output: `START${"x".repeat(40_000)}END` });
      yield* Effect.gen(function* () {
        yield* h.create;
        yield* h.send("large", "!large-output");
        const item = (yield* h.projection).turnItems.find(
          (item) => item.type === "command_execution" && item.userShell,
        );
        if (item?.type !== "command_execution" || !item.userShell)
          return yield* Effect.die("missing command");
        const fs = yield* FileSystem.FileSystem;
        expect(item.userShell?.outputTruncated).toBe(true);
        expect(yield* fs.readFileString(item.userShell.outputFile!)).toContain("x".repeat(40_000));
        const prompt = h.calls[0]!.message.text;
        expect(prompt).toContain("START");
        if (code === 0) {
          expect(prompt).toContain(`Output file: ${item.userShell?.outputFile}`);
          expect(item.output?.length).toBe(2000);
        } else {
          expect(prompt).toContain("END");
          expect(item.output!.length).toBeLessThan(10_010);
        }
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive"),
          threadId: h.threadId,
        });
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        expect(yield* fs.exists(item.userShell.outputFile!)).toBe(false);
      }).pipe(Effect.provide(Layer.mergeAll(h.layer, NodeServices.layer)));
    }),
);
