import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type UserCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as UserCommandService from "./UserCommandService.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

const command = (overrides: Partial<UserCommand> & { name: string }): UserCommand => ({
  description: "test",
  run: ["tool", "--flag"],
  output: "markdown",
  ...overrides,
});

interface Harness {
  readonly projectCommands: ReadonlyArray<UserCommand>;
  readonly worktreePath: string | null;
  readonly runnerOutput: Partial<ProcessRunner.ProcessRunOutput>;
}

const makeContext = Effect.fnUntraced(function* (harness: Harness) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-user-commands-" });
  const configPath = path.join(dir, "commands.json");
  const writes = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
  const runs = yield* Ref.make<ReadonlyArray<ProcessRunner.ProcessRunInput>>([]);
  const published = yield* Ref.make<ReadonlyArray<string>>([]);
  const layer = UserCommandService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerConfig.ServerConfig, { userCommandsConfigPath: configPath } as never),
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
          load: () => Effect.succeedSome({ commands: harness.projectCommands }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: "/project" } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              id === threadId
                ? ({ projectId, worktreePath: harness.worktreePath, latestRunId: null } as never)
                : null,
            ),
        }),
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) =>
            Ref.update(runs, (all) => [...all, input]).pipe(
              Effect.as({
                stdout: "",
                stderr: "",
                code: 0 as never,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
                ...harness.runnerOutput,
              }),
            ),
        }),
        Layer.mock(HtmlRender.HtmlRender)({
          publish: (input) =>
            Ref.update(published, (all) => [...all, "html" in input ? input.html : ""]).pipe(
              Effect.as({ attachmentId: "attachment-1", title: input.title, height: 480 }),
            ),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Ref.update(writes, (all) => [...all, ...events]).pipe(Effect.as([])),
        }),
        Layer.succeed(IdAllocator.IdAllocatorV2, {
          allocate: {
            userCommandTurnItem: () => Effect.succeed(TurnItemId.make("item-1")),
            event: () => Effect.succeed("event-1"),
          },
        } as never),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, configPath, writes, runs, published };
});

const withHarness = <A, E>(
  harness: Harness,
  body: (context: {
    readonly service: UserCommandService.UserCommandService["Service"];
    readonly configPath: string;
    readonly writes: Ref.Ref<ReadonlyArray<OrchestrationV2DomainEvent>>;
    readonly runs: Ref.Ref<ReadonlyArray<ProcessRunner.ProcessRunInput>>;
    readonly published: Ref.Ref<ReadonlyArray<string>>;
    readonly fileSystem: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const context = yield* makeContext(harness);
    return yield* Effect.gen(function* () {
      const service = yield* UserCommandService.UserCommandService;
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* body({ ...context, service, fileSystem });
    }).pipe(Effect.provide(context.layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const writtenItem = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
  const event = events.at(-1);
  assert.equal(event?.type, "turn-item.updated");
  return (event as Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }>).payload;
};

it.effect("lists user commands overridden by the project's, without their argv", () =>
  withHarness(
    {
      projectCommands: [command({ name: "graph", description: "project graph" })],
      worktreePath: null,
      runnerOutput: {},
    },
    ({ service, configPath, fileSystem }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(
          configPath,
          `{ // comments are allowed
            "commands": [
              { "name": "graph", "description": "user graph", "run": ["a"], "output": "html" },
              { "name": "model", "description": "clashes", "run": ["a"], "output": "html" },
              { "name": "todo", "description": "todo", "argumentHint": "[all]", "run": ["a"], "output": "markdown" },
            ],
          }`,
        );
        const { commands } = yield* service.list(projectId);
        assert.deepStrictEqual(commands, [
          { name: "graph", description: "project graph", output: "markdown", source: "project" },
          {
            name: "todo",
            description: "todo",
            argumentHint: "[all]",
            output: "markdown",
            source: "user",
          },
        ]);
      }),
  ),
);

it.effect("treats an invalid commands file as empty", () =>
  withHarness(
    { projectCommands: [], worktreePath: null, runnerOutput: {} },
    ({ service, configPath, fileSystem }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(configPath, `{ "commands": [{ "name": "bad name" }] }`);
        assert.deepStrictEqual((yield* service.list(projectId)).commands, []);
      }),
  ),
);

it.effect("runs a markdown command in the project root with typed args appended", () =>
  withHarness(
    {
      projectCommands: [command({ name: "hello", timeoutMs: 5_000 })],
      worktreePath: null,
      runnerOutput: { stdout: "# hi x y z" },
    },
    ({ service, runs, writes }) =>
      Effect.gen(function* () {
        const result = yield* service.run({ threadId, name: "hello", args: `x "y z"` });
        assert.equal(result.itemId, "item-1");
        const [run] = yield* Ref.get(runs);
        assert.equal(run?.command, "tool");
        assert.deepStrictEqual(run?.args, ["--flag", "x", "y z"]);
        assert.equal(run?.cwd, "/project");
        assert.equal(run?.timeout, 5_000);
        const item = writtenItem(yield* Ref.get(writes));
        if (item.type !== "user_command") return assert.fail("expected a user command item");
        assert.equal(item.status, "completed");
        assert.equal(item.command, "hello");
        assert.equal(item.args, `x "y z"`);
        assert.equal(item.markdown, "# hi x y z");
        assert.equal(item.runId, null);
      }),
  ),
);

it.effect("runs in the worktree of the thread and publishes html output", () =>
  withHarness(
    {
      projectCommands: [command({ name: "page", output: "html" })],
      worktreePath: NodeOS.tmpdir(),
      runnerOutput: { stdout: "<!doctype html><p>hi</p>" },
    },
    ({ service, runs, writes, published }) =>
      Effect.gen(function* () {
        yield* service.run({ threadId, name: "page", args: "" });
        assert.equal((yield* Ref.get(runs))[0]?.cwd, NodeOS.tmpdir());
        assert.deepStrictEqual(yield* Ref.get(published), ["<!doctype html><p>hi</p>"]);
        const item = writtenItem(yield* Ref.get(writes));
        if (item.type !== "user_command") return assert.fail("expected a user command item");
        assert.equal(item.status, "completed");
        assert.equal(item.htmlRender?.attachmentId, "attachment-1");
        assert.equal(item.markdown, undefined);
      }),
  ),
);

it.effect("runs in the project root once the thread's worktree is gone", () =>
  withHarness(
    {
      projectCommands: [command({ name: "page" })],
      worktreePath: "/removed-worktree",
      runnerOutput: {},
    },
    ({ service, runs }) =>
      Effect.gen(function* () {
        yield* service.run({ threadId, name: "page", args: "" });
        assert.equal((yield* Ref.get(runs))[0]?.cwd, "/project");
      }),
  ),
);

it.effect("shows stderr when the command exits non-zero", () =>
  withHarness(
    {
      projectCommands: [command({ name: "bad" })],
      worktreePath: null,
      runnerOutput: { code: 2 as never, stderr: "boom\n" },
    },
    ({ service, writes }) =>
      Effect.gen(function* () {
        yield* service.run({ threadId, name: "bad", args: "" });
        const item = writtenItem(yield* Ref.get(writes));
        if (item.type !== "user_command") return assert.fail("expected a user command item");
        assert.equal(item.status, "failed");
        assert.equal(item.error, "boom");
      }),
  ),
);

it.effect("reports a timeout", () =>
  withHarness(
    {
      projectCommands: [command({ name: "slow", timeoutMs: 2_000 })],
      worktreePath: null,
      runnerOutput: { code: null, timedOut: true },
    },
    ({ service, writes }) =>
      Effect.gen(function* () {
        yield* service.run({ threadId, name: "slow", args: "" });
        const item = writtenItem(yield* Ref.get(writes));
        if (item.type !== "user_command") return assert.fail("expected a user command item");
        assert.equal(item.status, "failed");
        assert.equal(item.error, "Timed out after 2s.");
      }),
  ),
);

it.effect("rejects unknown commands and threads", () =>
  withHarness({ projectCommands: [], worktreePath: null, runnerOutput: {} }, ({ service }) =>
    Effect.gen(function* () {
      const unknown = yield* Effect.flip(service.run({ threadId, name: "nope", args: "" }));
      assert.equal(unknown.reason, "unknown-command");
      const missing = yield* Effect.flip(
        service.run({ threadId: ThreadId.make("other"), name: "nope", args: "" }),
      );
      assert.equal(missing.reason, "thread-not-found");
    }),
  ),
);
