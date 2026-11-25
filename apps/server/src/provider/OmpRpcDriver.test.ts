import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { OmpRpcDriver } from "@t3tools/provider-omp/server";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const layer = Layer.mergeAll(
  TestProviderHost.layer({ runBackgroundWork: false }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeCrypto.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const makeOmpSpawner = (sessionFile = "/sessions/fixture.jsonl") => {
  const requests: Array<Record<string, unknown>> = [];
  const launches: Array<ChildProcess.StandardCommand> = [];
  const model = { provider: "fixture", id: "model", input: ["text"] };
  let nativeGoal: Record<string, unknown> | null = null;
  let leafId = "skill-entry";
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const probe = command.args[0];
      const config = probe === "config";
      const skills = probe === "skill";
      const output = config
        ? '{"value":true}\n'
        : skills
          ? '{"skills":[{"name":"workspace-test","description":"Test skill","filePath":"/work/SKILL.md","source":"project","hide":false}]}\n'
          : probe === "--version"
            ? "omp/19.1.1\n"
            : probe === "models"
              ? JSON.stringify({
                  models: [
                    { ...model, thinking: ["low", "high", "max"] },
                    { ...model, id: "plain" },
                  ],
                })
              : undefined;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode:
          output === undefined ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(output === undefined),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.gen(function* () {
            const request = decodeRequest(new TextDecoder().decode(bytes));
            requests.push(request);
            let data: unknown = {};
            switch (request.type) {
              case "get_state":
                data = { model, sessionFile, isSettled: true };
                break;
              case "get_available_commands":
                data = { commands: [{ name: "skill:workspace-test" }] };
                break;
              case "get_entries":
                data = { leafId, entries: [{ id: leafId }] };
                break;
              case "get_last_assistant_text":
                data = { text: '{"title":"Verify the native OMP integration"}' };
                break;
              case "goal":
                if (request.op === "create") {
                  nativeGoal = {
                    objective: request.objective,
                    status: "active",
                    tokenBudget: request.token_budget,
                  };
                  leafId = "goal-entry";
                } else if (request.op === "pause") {
                  nativeGoal = { ...nativeGoal, status: "paused" };
                }
                data = { goal: nativeGoal };
                break;
            }
            yield* Queue.offer(
              stdout,
              encode({
                type: "response",
                id: request.id,
                command: request.type,
                success: true,
                data,
              }),
            );
            if (request.type === "prompt") {
              yield* Queue.offer(
                stdout,
                encode({
                  type: "prompt_result",
                  id: request.id,
                  status: "completed",
                  agentInvoked: true,
                  sessionSettled: true,
                }),
              );
            }
          }),
        ),
        stdout:
          output === undefined
            ? Stream.fromQueue(stdout)
            : Stream.succeed(new TextEncoder().encode(output)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches, requests };
};

it.effect("generates a T3 title without opening a persistent or tool-enabled OMP session", () =>
  Effect.gen(function* () {
    const { spawner, launches, requests } = makeOmpSpawner();
    const instanceId = ProviderInstanceId.make("ompRpc");
    const instance = yield* OmpRpcDriver.create({
      instanceId,
      displayName: undefined,
      enabled: true,
      config: OmpRpcDriver.defaultConfig(),
      environment: [],
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const generated = yield* instance.textGeneration.generateThreadTitle({
      cwd: "/workspace",
      message: "Verify the native OMP integration",
      modelSelection: { instanceId, model: "fixture/model" },
    });
    expect(generated.title).toBe("Verify the native OMP integration");
    const generation = launches.find((launch) => launch.args.includes("--no-session"));
    expect(generation?.args).toEqual(
      expect.arrayContaining([
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-session",
      ]),
    );
    expect(requests.find((request) => request.type === "set_model")).toMatchObject({
      provider: "fixture",
      modelId: "model",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("lists native OMP sessions with title slots and validates their project ownership", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const otherCwd = yield* fs.makeTempDirectoryScoped();
    const directory = yield* fs.makeTempDirectoryScoped();
    const { spawner } = makeOmpSpawner(path.join(directory, "draft.jsonl"));
    const instance = yield* OmpRpcDriver.create({
      instanceId: ProviderInstanceId.make("ompRpc"),
      displayName: undefined,
      enabled: true,
      config: OmpRpcDriver.defaultConfig(),
      environment: [],
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const catalog = instance.nativeSessionCatalog!;
    const fixture = (n: number, sessionCwd = cwd) => {
      const id = `01a21228-1c41-7330-adb7-${String(n).padStart(12, "0")}`;
      return {
        file: path.join(directory, `2026-11-25T10-02-28-289Z_${id}.jsonl`),
        header: { type: "session", id, cwd: sessionCwd, title: "Legacy title" },
        message: { type: "message", message: { role: "user", content: "First prompt" } },
      };
    };
    const current = fixture(45);
    const foreign = fixture(44, otherCwd);
    const malformed = fixture(43);
    const symlink = fixture(42);
    const write = (file: string, entries: ReadonlyArray<unknown>) =>
      fs.writeFileString(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    yield* write(current.file, [
      { type: "title", title: "Current title" },
      current.header,
      current.message,
    ]);
    yield* write(foreign.file, [foreign.header, foreign.message]);
    yield* write(malformed.file, [{ type: "session" }, malformed.message]);
    if ((yield* HostProcess.Platform) !== "win32") yield* fs.symlink(current.file, symlink.file);
    yield* Effect.forEach(
      Array.from({ length: 41 }, (_, index) => fixture(index + 1)),
      (entry) => write(entry.file, [entry.header, entry.message]),
    );
    const first = yield* catalog.listSessions({ cwd });
    expect(first.sessions[0]).toMatchObject({
      sessionId: current.file,
      title: "Current title",
    });
    const second = yield* catalog.listSessions({ cwd, cursor: first.nextCursor! });
    const sessions = [...first.sessions, ...second.sessions];
    expect(new Set(sessions.map((entry) => entry.sessionId)).size).toBe(42);
    expect(sessions.length).toBe(42);
    expect(second.sessions.at(-1)).toMatchObject({
      sessionId: fixture(1).file,
      title: "Legacy title",
    });
    expect(second.nextCursor).toBeNull();
    yield* catalog.validateSession({ cwd, sessionId: current.file });
    for (const sessionId of [foreign.file, malformed.file, symlink.file, fixture(99).file]) {
      expect(yield* catalog.validateSession({ cwd, sessionId }).pipe(Effect.flip)).toMatchObject({
        reason: "session_import_failed",
      });
    }
    expect(
      yield* catalog.validateSession({ cwd: otherCwd, sessionId: current.file }).pipe(Effect.flip),
    ).toMatchObject({ reason: "session_import_failed" });
  }).pipe(Effect.provide(layer)),
);

it.effect("offers native Auto effort only for Oh My Pi models with selectable effort", () =>
  Effect.gen(function* () {
    const { spawner, launches } = makeOmpSpawner();
    const instance = yield* OmpRpcDriver.create({
      instanceId: ProviderInstanceId.make("ompRpc"),
      displayName: undefined,
      enabled: true,
      config: OmpRpcDriver.defaultConfig(),
      environment: [],
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const snapshot = yield* instance.snapshot.refresh;
    expect(snapshot.models.find((model) => model.slug === "fixture/model")).toMatchObject({
      capabilities: {
        optionDescriptors: [
          {
            id: "thinking",
            options: ["off", "auto", "low", "high", "max"].map((id) => ({ id })),
          },
        ],
      },
    });
    expect(
      snapshot.models.find((model) => model.slug === "fixture/plain")?.capabilities,
    ).toBeNull();
    expect(launches.map((command) => command.args[0])).toEqual(["--version", "models"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("discovers a workspace Skill and runs it with native Goals in one Oh My Pi session", () =>
  Effect.gen(function* () {
    const { spawner, launches, requests } = makeOmpSpawner();
    const instanceId = ProviderInstanceId.make("ompRpc");
    const instance = yield* OmpRpcDriver.create({
      instanceId,
      displayName: undefined,
      enabled: true,
      config: OmpRpcDriver.defaultConfig(),
      environment: [],
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const initial = yield* instance.snapshotForCwd!("/work");
    expect(initial.skills?.map((skill) => skill.name)).toEqual(["workspace-test"]);
    expect(launches.map((command) => command.args[0])).toEqual(["config", "skill"]);

    const runtimeInput = {
      threadId: ThreadId.make("omp-thread"),
      providerSessionId: ProviderSessionId.make("omp-session"),
      modelSelection: {
        instanceId,
        model: "fixture/model",
        options: [{ id: "thinking", value: "auto" }],
      },
      runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: "/work" },
    } as const;
    const runtime = yield* instance.orchestrationAdapter.openSession(runtimeInput);
    const providerThread = yield* runtime.ensureThread(runtimeInput);
    const now = yield* DateTime.now;
    const appThread = {
      id: runtimeInput.threadId,
      projectId: ProjectId.make("omp-project"),
      title: "Oh My Pi fixture",
      providerInstanceId: instanceId,
      modelSelection: runtimeInput.modelSelection,
      ...runtimeInput.runtimePolicy,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: runtimeInput.threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      createdBy: "user",
      creationSource: "server",
    } as const;
    for (const [index, text] of [
      "/skill:workspace-test verify",
      "/goal set --budget 2000 Run tests",
      "/goal pause",
    ].entries()) {
      const ordinal = index + 1;
      const result = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* runtime.startTurn({
        ...runtimeInput,
        appContext: [],
        appThread,
        providerThread,
        runId: RunId.make(`run-${ordinal}`),
        runOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt-${ordinal}`),
        rootNodeId: NodeId.make(`node-${ordinal}`),
        providerTurnOrdinal: ordinal,
        message: {
          messageId: MessageId.make(`message-${ordinal}`),
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "server",
        },
      });
      const events = yield* Fiber.join(result);
      expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
      const finalThread = events.findLast((event) => event.type === "provider_thread.updated");
      expect(finalThread).toMatchObject({
        providerThread: {
          nativeConversationHeadRef: { nativeId: ordinal === 1 ? "skill-entry" : "goal-entry" },
        },
      });
      expect(finalThread).not.toHaveProperty("sessionScoped", true);
      if (ordinal > 1) {
        expect(finalThread).toMatchObject({
          providerThread: {
            goal: {
              objective: "Run tests",
              tokenBudget: 2000,
              status: ordinal === 2 ? "active" : "paused",
            },
          },
        });
      }
    }
    const promptIndex = requests.findIndex((request) => request.type === "prompt");
    expect(requests.slice(0, promptIndex)).toContainEqual(
      expect.objectContaining({ type: "set_thinking_level", level: "auto" }),
    );
    expect(requests.filter((request) => request.type === "prompt")).toEqual([
      expect.objectContaining({ message: "/skill:workspace-test verify" }),
    ]);
    expect(
      launches
        .filter((command) => command.args[0] === "--mode")
        .map((command) => command.args.slice(0, 2)),
    ).toEqual([["--mode", "rpc"]]);
  }).pipe(Effect.provide(layer)),
);
