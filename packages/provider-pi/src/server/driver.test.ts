import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

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

const makePiSpawner = Effect.fnUntraced(function* (
  discovery: {
    readonly state?: unknown;
    readonly models?: ReadonlyArray<unknown>;
    /** Pi's Anthropic OAuth token; without one Pi reports no subscription sign-in. */
    readonly anthropicToken?: string;
  } = {},
) {
  const pendingCommand = yield* Deferred.make<void>();
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      const bearer = command.args[0] === "auth" && command.args[1] === "print-bearer-token";
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const cwd = command.options.cwd;
      const exit = (output: string, code = 0) => ({
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        stdout: Stream.succeed(encoder.encode(output)),
      });
      return ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so transport cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeRequest(new TextDecoder().decode(chunk).trim());
          if (cwd === "/pending" && request.type === "get_commands") {
            return Deferred.succeed(pendingCommand, undefined).pipe(Effect.asVoid);
          }
          const failed = cwd === "/failed" && request.type === "get_commands";
          const data =
            request.type === "get_commands"
              ? {
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
                ? { models: discovery.models ?? [{ provider: "test", id: "model" }] }
                : request.type === "get_state"
                  ? (discovery.state ?? {})
                  : {};
          return Queue.offer(
            stdout,
            encoder.encode(
              `${JSON.stringify({ type: "response", id: request.id, success: !failed, data, ...(failed ? { error: "commands unavailable" } : {}) })}\n`,
            ),
          ).pipe(Effect.asVoid);
        }),
        stdout: Stream.fromQueue(stdout),
        stderr:
          bearer && discovery.anthropicToken === undefined
            ? Stream.succeed(
                encoder.encode(
                  'Error: Provider "anthropic" is not configured with an OAuth bearer token\n',
                ),
              )
            : Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        ...(version ? exit("pi 1.0.2\n") : {}),
        ...(bearer
          ? exit(`${discovery.anthropicToken ?? ""}\n`, discovery.anthropicToken ? 0 : 1)
          : {}),
      });
    }),
  );
  return { spawner, launches, pendingCommand };
});

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
  it.effect("keeps each workspace's skills and commands separate from the machine catalog", () =>
    Effect.gen(function* () {
      const { spawner, launches } = yield* makePiSpawner();
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
      // Pi has no Anthropic subscription sign-in, so there is no usage section or request.
      assert.isUndefined(machine.usageLimits);
      assert.equal(first.instanceId, instance.instanceId);
      assert.equal(first.displayName, "My Pi");
      assert.equal(first.accentColor, "#abcdef");
      assert.deepEqual(first.models, machine.models);
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

  it.effect("publishes the Claude limits behind Pi's Anthropic sign-in for Anthropic models", () =>
    Effect.gen(function* () {
      const { spawner, launches } = yield* makePiSpawner({ anthropicToken: "pi-oauth-token" });
      const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> =
        [];
      const httpClient = HttpClient.make((request) => {
        requests.push({ url: request.url, authorization: request.headers["authorization"] });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                five_hour: { utilization: 34, resets_at: "2026-11-20T14:30:00.276840+00:00" },
                seven_day: { utilization: 53, resets_at: "2026-11-22T04:00:00.276862+00:00" },
                seven_day_opus: null,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        );
      });
      const instance = yield* create().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.deepEqual(snapshot.usageLimits?.windows, [
        {
          id: "anthropic_five_hour",
          kind: "session",
          label: "Claude · Session",
          windowDurationMins: 300,
          providerIds: ["anthropic"],
          usedPercent: 34,
          resetsAt: "2026-11-20T14:30:00.276Z",
        },
        {
          id: "anthropic_seven_day",
          kind: "weekly",
          label: "Claude · Weekly",
          windowDurationMins: 10080,
          providerIds: ["anthropic"],
          usedPercent: 53,
          resetsAt: "2026-11-22T04:00:00.276Z",
        },
      ]);
      assert.isUndefined(snapshot.usageLimits?.unavailable);
      assert.deepEqual(requests, [
        {
          url: "https://api.anthropic.com/api/oauth/usage",
          authorization: "Bearer pi-oauth-token",
        },
      ]);
      const tokenLaunch = launches.find((launch) => launch.args[0] === "auth");
      assert.equal(tokenLaunch?.command, "custom-pi");
      assert.equal(tokenLaunch?.options.env?.PI_CODING_AGENT_DIR, "/isolated-pi");
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

  it.effect(
    "fails command discovery instead of returning an empty successful workspace catalog",
    () =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner();
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        assert.isDefined(instance.snapshotForCwd);
        const error = yield* Effect.flip(instance.snapshotForCwd!("/failed"));
        assert.equal(error._tag, "ProviderDriverError");
        assert.equal(error.instanceId, instance.instanceId);
        assert.deepEqual(
          (yield* instance.snapshot.getSnapshot).skills.map((skill) => skill.name),
          ["personal"],
        );
      }),
  );
});
