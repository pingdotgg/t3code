import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginId } from "@t3tools/contracts/plugin";
import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { makeDatabaseCapability } from "./DatabaseCapability.ts";
import { makeEnvironmentsReadCapability } from "./EnvironmentsReadCapability.ts";
import { makeProjectionsReadCapability } from "./ProjectionsReadCapability.ts";
import { makeSecretsCapability } from "./SecretsCapability.ts";
import { makeSourceControlCapability } from "./SourceControlCapability.ts";
import { makeTerminalsCapability } from "./TerminalsCapability.ts";
import { makeTextGenerationCapability } from "./TextGenerationCapability.ts";

class RollbackTestError extends Data.TaggedError("RollbackTestError") {}

it.effect("database executes parameterized SQL and rolls back failed transactions", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const database = makeDatabaseCapability(sql);

    yield* database.execute("CREATE TABLE p_test_plugin_items (id TEXT PRIMARY KEY, value TEXT)");
    yield* database.execute("INSERT INTO p_test_plugin_items (id, value) VALUES (?, ?)", [
      "one",
      "kept",
    ]);
    const rows = yield* database.execute("SELECT id, value FROM p_test_plugin_items WHERE id = ?", [
      "one",
    ]);
    assert.deepEqual(rows, [{ id: "one", value: "kept" }]);

    yield* database
      .withTransaction(
        Effect.gen(function* () {
          yield* database.execute("INSERT INTO p_test_plugin_items (id, value) VALUES (?, ?)", [
            "two",
            "rolled-back",
          ]);
          return yield* new RollbackTestError();
        }),
      )
      .pipe(Effect.flip);

    const afterRollback = yield* database.execute(
      "SELECT id FROM p_test_plugin_items WHERE id = ?",
      ["two"],
    );
    assert.deepEqual(afterRollback, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("secrets enforce and strip the plugin key prefix", () =>
  Effect.gen(function* () {
    const pluginId = PluginId.make("secret-plugin");
    const store = yield* ServerSecretStore.ServerSecretStore;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const secrets = makeSecretsCapability({ pluginId, store, config, fileSystem, path });

    const value = new TextEncoder().encode("secret-value");
    yield* secrets.set("api-key", value);

    const stored = yield* secrets.get("api-key");
    assert.deepEqual(Array.from(stored ?? []), Array.from(value));
    assert.deepEqual(yield* secrets.list, ["api-key"]);
    assert.isTrue(Option.isNone(yield* store.get("api-key")));
    assert.isTrue(Option.isSome(yield* store.get(`plugin:${pluginId}:api-key`)));

    // Names outside the safe grammar are rejected: the backing store maps
    // keys to file paths, so separators/colons/traversal must never reach it.
    for (const invalidName of ["plugin:other:key", "../escape", "a/b", "a\\b", ".hidden", ""]) {
      const rejected = yield* Effect.result(
        secrets.set(invalidName, new TextEncoder().encode("nope")),
      );
      assert.isTrue(Result.isFailure(rejected), `expected rejection for ${invalidName}`);
    }

    yield* secrets.delete("api-key");
    assert.isNull(yield* secrets.get("api-key"));
  }).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(
          Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-secrets-" })),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("environments read delegates to environment and projection snapshots", () =>
  Effect.gen(function* () {
    const projectShell = { id: "project-1", title: "Project" } as any;
    const project = { id: "project-1", workspaceRoot: "/repo" } as any;
    const capability = makeEnvironmentsReadCapability({
      environment: {
        getEnvironmentId: Effect.succeed("env-1" as any),
        getDescriptor: Effect.succeed({ environmentId: "env-1", label: "Local" } as any),
      },
      snapshots: {
        getShellSnapshot: () => Effect.succeed({ projects: [projectShell], threads: [] } as any),
        getProjectShellById: () => Effect.succeed(Option.some(projectShell)),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      } as any,
    });

    assert.equal(yield* capability.getEnvironmentId, "env-1");
    assert.deepEqual(yield* capability.listProjects, [projectShell]);
    assert.deepEqual(yield* capability.getProjectById("project-1" as any), projectShell);
    assert.deepEqual(yield* capability.resolveProjectByWorkspaceRoot("/repo"), project);
  }),
);

it.effect("projections read returns contract-shaped thread data with caps", () =>
  Effect.gen(function* () {
    const threadShell = { id: "thread-1", title: "Thread" } as any;
    const threadDetail = { id: "thread-1", messages: [], activities: [] } as any;
    const capability = makeProjectionsReadCapability({
      snapshots: {
        getThreadShellById: () => Effect.succeed(Option.some(threadShell)),
        getThreadDetailById: () => Effect.succeed(Option.some(threadDetail)),
      } as any,
      turns: {
        listByThreadId: () =>
          Effect.succeed([
            {
              threadId: "thread-1",
              turnId: "turn-1",
              pendingMessageId: null,
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              assistantMessageId: null,
              state: "completed",
              requestedAt: "2026-07-03T00:00:00.000Z",
              startedAt: null,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            },
          ] as any),
      } as any,
      messages: {
        listByThreadId: () =>
          Effect.succeed([
            {
              messageId: "message-1",
              threadId: "thread-1",
              turnId: "turn-1",
              role: "assistant",
              text: "hello",
              isStreaming: false,
              createdAt: "2026-07-03T00:00:00.000Z",
              updatedAt: "2026-07-03T00:00:01.000Z",
            },
            {
              messageId: "message-2",
              threadId: "thread-1",
              turnId: "turn-1",
              role: "assistant",
              text: "ignored by cap",
              isStreaming: false,
              createdAt: "2026-07-03T00:00:02.000Z",
              updatedAt: "2026-07-03T00:00:03.000Z",
            },
          ] as any),
        getByMessageId: (input: { readonly messageId: string }) =>
          Effect.succeed(
            input.messageId === "message-1"
              ? Option.some({
                  messageId: "message-1",
                  threadId: "thread-1",
                  turnId: "turn-1",
                  role: "assistant",
                  text: "hello",
                  isStreaming: false,
                  createdAt: "2026-07-03T00:00:00.000Z",
                  updatedAt: "2026-07-03T00:00:01.000Z",
                } as any)
              : Option.none(),
          ),
      } as any,
      activities: {
        listByThreadId: () =>
          Effect.succeed([
            {
              activityId: "activity-1",
              threadId: "thread-1",
              turnId: null,
              tone: "info",
              kind: "note",
              summary: "summary",
              payload: { ok: true },
              createdAt: "2026-07-03T00:00:00.000Z",
            },
          ] as any),
      } as any,
    });

    assert.deepEqual(yield* capability.getThreadShellById("thread-1" as any), threadShell);
    assert.deepEqual(yield* capability.getThreadDetailById("thread-1" as any), threadDetail);
    assert.equal(
      (yield* capability.listTurnsByThreadId({ threadId: "thread-1" as any })).length,
      1,
    );
    assert.deepEqual(
      yield* capability.listMessagesByThreadId({ threadId: "thread-1" as any, limit: 1 }),
      [
        {
          id: "message-1" as any,
          role: "assistant",
          text: "hello",
          turnId: "turn-1" as any,
          streaming: false,
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:01.000Z",
        },
      ],
    );
    assert.deepEqual(yield* capability.getMessageById("message-1" as any), {
      id: "message-1" as any,
      role: "assistant",
      text: "hello",
      turnId: "turn-1" as any,
      streaming: false,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:01.000Z",
    });
    assert.equal(yield* capability.getMessageById("message-missing" as any), null);
    assert.deepEqual(yield* capability.listActivitiesByThreadId({ threadId: "thread-1" as any }), [
      {
        id: "activity-1" as any,
        tone: "info",
        kind: "note",
        summary: "summary",
        payload: { ok: true },
        turnId: null,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    ]);
  }),
);

it.effect("text generation delegates the existing one-shot operations", () =>
  Effect.gen(function* () {
    const capability = makeTextGenerationCapability({
      generateCommitMessage: (input) =>
        Effect.succeed({ subject: `commit:${input.branch}`, body: input.stagedSummary }),
      generatePrContent: (input) =>
        Effect.succeed({ title: input.headBranch, body: input.diffSummary }),
      generateBranchName: (input) => Effect.succeed({ branch: `feature/${input.message}` }),
      generateThreadTitle: (input) => Effect.succeed({ title: input.message.slice(0, 10) }),
    });
    const modelSelection = { instanceId: "codex", model: "gpt-test" } as any;

    assert.deepEqual(
      yield* capability.generateCommitMessage({
        cwd: "/repo",
        branch: "main",
        stagedSummary: "summary",
        stagedPatch: "patch",
        modelSelection,
      }),
      { subject: "commit:main", body: "summary" },
    );
    assert.deepEqual(
      yield* capability.generatePrContent({
        cwd: "/repo",
        baseBranch: "main",
        headBranch: "feature",
        commitSummary: "commits",
        diffSummary: "diff",
        diffPatch: "patch",
        modelSelection,
      }),
      { title: "feature", body: "diff" },
    );
    assert.deepEqual(
      yield* capability.generateBranchName({ cwd: "/repo", message: "work", modelSelection }),
      { branch: "feature/work" },
    );
    assert.deepEqual(
      yield* capability.generateThreadTitle({
        cwd: "/repo",
        message: "hello world",
        modelSelection,
      }),
      { title: "hello worl" },
    );
  }),
);

it.effect("source control exposes provider detection and existing GitHub CLI PR operations", () =>
  Effect.gen(function* () {
    const createInputs: unknown[] = [];
    const capability = makeSourceControlCapability({
      registry: {
        resolveHandle: () =>
          Effect.succeed({
            provider: {} as any,
            context: {
              provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
              remoteName: "origin",
              remoteUrl: "git@github.com:owner/repo.git",
            },
          }),
        discover: Effect.succeed([{ kind: "github", status: "available" } as any]),
      } as any,
      github: {
        listOpenPullRequests: () =>
          Effect.succeed([
            {
              number: 1,
              title: "PR",
              url: "https://github.com/o/r/pull/1",
              baseRefName: "main",
              headRefName: "feature",
            },
          ]),
        getPullRequest: () =>
          Effect.succeed({
            number: 2,
            title: "Detail",
            url: "https://github.com/o/r/pull/2",
            baseRefName: "main",
            headRefName: "fix",
          }),
        createPullRequest: (input: any) =>
          Effect.sync(() => {
            createInputs.push(input);
          }),
        getDefaultBranch: () => Effect.succeed("main"),
        checkoutPullRequest: () => Effect.void,
      } as any,
    });

    assert.deepEqual(yield* capability.detectProvider({ cwd: "/repo" }), {
      provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      remoteName: "origin",
      remoteUrl: "git@github.com:owner/repo.git",
    });
    assert.equal((yield* capability.discoverProviders)[0]?.kind, "github");
    assert.equal(
      (yield* capability.listOpenPullRequests({ cwd: "/repo", headSelector: "feature" }))[0]
        ?.number,
      1,
    );
    assert.equal((yield* capability.getPullRequest({ cwd: "/repo", reference: "2" })).number, 2);
    yield* capability.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature",
      title: "PR",
      bodyFile: "/tmp/body.md",
    });
    assert.equal(createInputs.length, 1);
    assert.equal(yield* capability.getDefaultBranch({ cwd: "/repo" }), "main");
    yield* capability.checkoutPullRequest({ cwd: "/repo", reference: "2" });
  }),
);

it.effect(
  "terminals spawn through a plugin-owned shell session and expose observe/input/kill",
  () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const closes: unknown[] = [];
      const snapshot: TerminalSessionSnapshot = {
        threadId: "plugin:terminal-plugin:run-1",
        terminalId: "run-1",
        cwd: "/repo",
        worktreePath: null,
        status: "running",
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "run",
        updatedAt: "2026-07-03T00:00:00.000Z",
      };
      const { capability, shutdown } = makeTerminalsCapability({
        pluginId: PluginId.make("terminal-plugin"),
        manager: {
          open: () => Effect.succeed(snapshot),
          attachStream: (
            _input: any,
            listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
          ) =>
            listener({ type: "snapshot", snapshot } satisfies TerminalAttachStreamEvent).pipe(
              Effect.as(() => undefined),
            ),
          write: (input: any) =>
            Effect.sync(() => {
              writes.push(input.data);
            }),
          close: (input: any) =>
            Effect.sync(() => {
              closes.push(input);
            }),
        } as any,
      });

      const spawned = yield* capability.spawn({
        terminalId: "run-1",
        cwd: "/repo",
        command: "echo",
        args: ["hello world"],
      });
      assert.deepEqual(spawned.handle, {
        threadId: "plugin:terminal-plugin:run-1",
        terminalId: "run-1",
      });
      assert.deepEqual(writes, ["'echo' 'hello world'\n"]);

      const events: TerminalAttachStreamEvent[] = [];
      const unsubscribe = yield* capability.observe(spawned.handle, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      );
      unsubscribe();
      assert.equal(events[0]?.type, "snapshot");

      yield* capability.sendInput({ ...spawned.handle, data: "q" });
      yield* capability.kill({ ...spawned.handle, deleteHistory: true });
      assert.equal(writes.at(-1), "q");
      assert.deepEqual(closes, [{ ...spawned.handle, deleteHistory: true }]);

      // A killed terminal is no longer tracked, so shutdown closes nothing.
      yield* shutdown;
      assert.equal(closes.length, 1);

      // A terminal left open IS closed by shutdown (the scope-close leak guard).
      const leaked = yield* capability.spawn({
        terminalId: "run-2",
        cwd: "/repo",
        command: "sleep",
        args: ["100"],
      });
      yield* shutdown;
      assert.deepEqual(closes.at(-1), {
        threadId: leaked.handle.threadId,
        terminalId: leaked.handle.terminalId,
      });
    }),
);
