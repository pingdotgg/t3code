import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { PiSettings } from "../settings.ts";
import { PiDriver } from "./driver.ts";

const layerTest = Layer.mergeAll(
  TestProviderHost.layer({
    cwd: "/machine",
    settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    runBackgroundWork: false,
  }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Unexpected HTTP")),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encoder = new TextEncoder();
const personalSkill = {
  name: "skill:personal",
  source: "skill",
  sourceInfo: { scope: "user", path: "/home/.pi/agent/skills/personal/SKILL.md" },
};

const makePiSpawner = (
  discovery: {
    readonly state?: unknown;
    readonly models?: ReadonlyArray<unknown>;
    readonly workspaceModels?: Record<string, ReadonlyArray<unknown>>;
  } = {},
) => {
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const cwd = command.options.cwd;
      if (cwd === "/late-commands" || cwd === "/late-models") yield* Effect.sleep("20 seconds");
      return ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so transport cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!version),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeRequest(new TextDecoder().decode(chunk).trim());
          if (
            (cwd === "/late-commands" && request.type === "get_commands") ||
            (cwd === "/late-models" && request.type === "get_available_models")
          )
            return Effect.void;
          const failed =
            (cwd === "/failed-commands" && request.type === "get_commands") ||
            (cwd === "/failed-state" && request.type === "get_state");
          const data =
            request.type === "get_commands"
              ? cwd === "/invalid-commands"
                ? { commands: null }
                : cwd === "/empty-commands"
                  ? { commands: [] }
                  : {
                      commands: [
                        personalSkill,
                        ...(cwd?.endsWith("/pi-status-probe")
                          ? []
                          : [
                              {
                                name: `skill:${cwd?.slice(1)}`,
                                source: "skill",
                                sourceInfo: {
                                  scope: "project",
                                  path: `${cwd}/.agents/skills/SKILL.md`,
                                },
                              },
                              { name: `prompt-${cwd?.slice(1)}`, source: "prompt" },
                            ]),
                      ],
                    }
              : request.type === "get_available_models"
                ? cwd === "/invalid-models"
                  ? {}
                  : {
                      models: [
                        ...(discovery.models ?? [{ provider: "test", id: "model" }]),
                        ...(discovery.workspaceModels?.[cwd ?? ""] ?? []),
                      ],
                    }
                : request.type === "get_state"
                  ? (discovery.state ?? {})
                  : {};
          return Queue.offer(
            stdout,
            encoder.encode(
              `${JSON.stringify({ type: "response", id: request.id, success: !failed, data, ...(failed ? { error: "inventory unavailable" } : {}) })}\n`,
            ),
          ).pipe(Effect.asVoid);
        }),
        stdout: version ? Stream.succeed(encoder.encode("pi 1.0.2\n")) : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return Effect.succeed({ spawner, launches });
};

const create = (config: Partial<PiSettings> = {}, enabled = true) =>
  PiDriver.create({
    instanceId: ProviderInstanceId.make("pi-workspace-test"),
    displayName: "My Pi",
    accentColor: "#abcdef",
    environment: [{ name: "PI_CODING_AGENT_DIR", value: "/isolated-pi", sensitive: false }],
    enabled,
    config: { ...PiDriver.defaultConfig(), binaryPath: "custom-pi", ...config },
  });

it.layer(layerTest)("PiDriver workspace discovery", (it) => {
  it.effect("keeps each workspace's inventory separate from the machine catalog", () =>
    Effect.gen(function* () {
      const { spawner, launches } = yield* makePiSpawner({
        workspaceModels: {
          "/first": [{ provider: "test", id: "first" }],
          "/second": [{ provider: "test", id: "second" }],
        },
      });
      const instance = yield* create({ launchArgs: '--approve --skill "extra skill"' }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      assert.isDefined(instance.snapshotForCwd);
      const [first, second] = yield* Effect.all(
        [instance.snapshotForCwd!("/first"), instance.snapshotForCwd!("/second")],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        first.skills.map((skill) => skill.name),
        ["personal", "first"],
      );
      assert.deepEqual(
        second.skills.map((skill) => skill.name),
        ["personal", "second"],
      );
      assert.deepEqual(
        first.slashCommands.map((command) => command.name),
        ["compact", "prompt-first"],
      );
      const machine = yield* instance.snapshot.getSnapshot;
      assert.deepEqual(
        machine.skills.map((skill) => skill.name),
        ["personal"],
      );
      assert.deepEqual(
        machine.slashCommands.map((command) => command.name),
        ["compact"],
      );
      assert.equal(first.instanceId, instance.instanceId);
      assert.equal(first.displayName, "My Pi");
      assert.equal(first.accentColor, "#abcdef");
      assert.deepEqual(first.models, machine.models);
      const plain = yield* instance.snapshotForCwd!("/plain");
      assert.isUndefined(plain.workspaceModels);
      assert.isFalse(
        launches.some(
          (launch) => launch.options.cwd === "/first" && launch.args.includes("--no-extensions"),
        ),
      );
      assert.deepEqual(
        [machine.models, first.workspaceModels, second.workspaceModels].map((models) =>
          models?.map((model) => model.slug),
        ),
        [
          ["default", "test/model"],
          ["default", "test/model", "test/first"],
          ["default", "test/model", "test/second"],
        ],
      );
      const workspaceLaunch = launches.find((launch) => launch.options.cwd === "/first");
      assert.isDefined(workspaceLaunch);
      assert.equal(workspaceLaunch!.command, "custom-pi");
      assert.includeMembers(
        [...workspaceLaunch!.args],
        ["--approve", "--skill", "extra skill", "--no-session"],
      );
      assert.equal(workspaceLaunch!.options.env?.PI_CODING_AGENT_DIR, "/isolated-pi");
      // Discovery processes are stopped as soon as they answer, so neither may start Pi's
      // network refresh at launch.
      assert.isFalse(launches.some((launch) => launch.options.cwd === "/machine"));
      for (const isLaunch of [
        (cwd: string | undefined) => cwd?.endsWith("/pi-status-probe") === true,
        (cwd: string | undefined) => cwd === "/first",
      ]) {
        const discovery = launches.find(
          (launch) => isLaunch(launch.options.cwd) && launch.args.includes("--mode"),
        );
        assert.deepEqual(
          discovery?.args.filter((arg) => arg === "--offline"),
          ["--offline"],
        );
      }
    }),
  );

  it.effect("does not run a disabled provider's workspace probe", () =>
    Effect.gen(function* () {
      const instance = yield* create({}, false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled Pi must not spawn")),
        ),
      );
      assert.isDefined(instance.snapshotForCwd);
      const workspace = yield* instance.snapshotForCwd!("/first");
      assert.isFalse(workspace.enabled);
      assert.deepEqual(workspace.skills, []);
    }),
  );

  it.effect.each([true, false])(
    "limits discovered thinking defaults to the known active model, known=%s",
    (known) =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner({
          state: {
            thinkingLevel: "high",
            ...(known ? { model: { provider: "test", id: "model" } } : {}),
          },
          models: [
            { provider: "test", id: "model", reasoning: true },
            { provider: "other", id: "model", reasoning: true },
            { provider: "test", id: "other", reasoning: true },
          ],
        });
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        const snapshot = yield* instance.snapshot.getSnapshot;
        assert.deepEqual(
          snapshot.models.map((model) => [
            model.slug,
            (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
              descriptor.type === "select"
                ? descriptor.options.filter((option) => option.isDefault).map((option) => option.id)
                : [],
            ),
          ]),
          [
            ["default", []],
            ["test/model", known ? ["high"] : []],
            ["other/model", []],
            ["test/other", []],
          ],
        );
      }),
  );

  it.effect("signs Pi in for a project whose own config lists models", () =>
    Effect.gen(function* () {
      const { spawner } = yield* makePiSpawner({
        models: [],
        workspaceModels: { "/project": [{ provider: "test", id: "project" }] },
      });
      const instance = yield* create().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      assert.equal((yield* instance.snapshot.getSnapshot).auth.status, "unauthenticated");
      assert.equal(
        (yield* instance.snapshotForCwd!("/project")).workspaceAuth?.status,
        "authenticated",
      );
      assert.isUndefined((yield* instance.snapshotForCwd!("/empty")).workspaceAuth);
    }),
  );

  it.effect.each([
    { cwd: "/failed-commands", modelsPending: undefined, commandsPending: true },
    { cwd: "/invalid-commands", modelsPending: undefined, commandsPending: true },
    { cwd: "/empty-commands", modelsPending: undefined, commandsPending: false },
    { cwd: "/invalid-models", modelsPending: true, commandsPending: false },
    { cwd: "/failed-state", modelsPending: undefined, commandsPending: false },
  ])("publishes the available inventory for $cwd", ({ cwd, modelsPending, commandsPending }) =>
    Effect.gen(function* () {
      const { spawner } = yield* makePiSpawner({
        workspaceModels: { [cwd]: [{ provider: "test", id: "workspace" }] },
      });
      const instance = yield* create().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      const workspace = yield* instance.snapshotForCwd!(cwd);
      assert.equal(workspace.workspaceModelsPending, modelsPending);
      assert.equal(workspace.slashCommandsPending, commandsPending);
      assert.equal(workspace.workspaceSkillsPending, commandsPending ? true : undefined);
      assert.deepEqual(
        workspace.workspaceModels?.map((model) => model.slug),
        modelsPending ? undefined : ["default", "test/model", "test/workspace"],
      );
      assert.deepEqual(
        workspace.skills.map((skill) => skill.name),
        commandsPending
          ? ["personal"]
          : cwd === "/empty-commands"
            ? []
            : ["personal", cwd.slice(1)],
      );
    }),
  );
  it.effect.each([
    { cwd: "/late-commands", modelsPending: false, commandsPending: true },
    { cwd: "/late-models", modelsPending: true, commandsPending: false },
  ])("keeps the inventory available by the shared deadline for $cwd", (row) =>
    Effect.gen(function* () {
      const { spawner } = yield* makePiSpawner({
        workspaceModels: { [row.cwd]: [{ provider: "test", id: "workspace" }] },
      });
      const instance = yield* create().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      const scan = yield* instance.snapshotForCwd!(row.cwd).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.isDefined(scan.pollUnsafe());
      const workspace = yield* Fiber.join(scan);
      assert.equal(workspace.workspaceModelsPending ?? false, row.modelsPending);
      assert.equal(workspace.slashCommandsPending, row.commandsPending);
      assert.deepEqual(
        workspace.workspaceModels?.map((model) => model.slug),
        row.modelsPending ? undefined : ["default", "test/model", "test/workspace"],
      );
      assert.deepEqual(
        workspace.skills.map((skill) => skill.name),
        row.commandsPending ? ["personal"] : ["personal", row.cwd.slice(1)],
      );
    }),
  );
});
