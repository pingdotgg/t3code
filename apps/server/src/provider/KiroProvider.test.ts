import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
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
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { KiroDriver } from "@t3tools/provider-kiro/server";
import { KiroSettings } from "@t3tools/provider-kiro/settings";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  checkKiroProviderStatus,
  kiroAgentDescriptor,
  kiroDefaultModelId,
} from "@t3tools/provider-kiro/testing";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(KiroSettings)({ enabled: true });

interface CliOutput {
  readonly stdout: string;
  readonly code: number;
  /** Holds stdout and the exit back this long, like a CLI slow to answer. */
  readonly delay?: Duration.Input;
}

function processHandle(output: CliOutput) {
  const answered = Effect.sleep(output.delay ?? 0);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_002),
    exitCode: Effect.as(answered, ChildProcessSpawner.ExitCode(output.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.unwrap(
      Effect.as(
        answered,
        output.stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(output.stdout)),
      ),
    ),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const KIRO_ACP_ARGS = "acp --agent-engine=v3 --auth-method=cli";
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.Union([Schema.String, Schema.Number]), method: Schema.String }),
  ),
);
const KIRO_SESSION_ID = "sess_kiro-skills";

/**
 * A `kiro-cli acp` that answers `initialize` and `_kiro/config/template` and
 * fails anything else, so a probe that opened a session would fail. Given
 * `afterSessionNew`, it also opens sessions, sends those updates right after
 * `session/new`, and answers each prompt with one line of text.
 */
const acpProcess = (template: unknown, afterSessionNew?: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array>();
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const terminate = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(
      Effect.andThen(Queue.shutdown(output)),
      Effect.asVoid,
    );
    let pending = "";
    const send = (message: object) =>
      Queue.offer(output, encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
    const sessionUpdate = (update: unknown) =>
      send({
        method: "session/update",
        params: { sessionId: KIRO_SESSION_ID, update },
      });
    const reply = Effect.fnUntraced(function* (line: string) {
      const request = decodeRequest(line);
      const sessions = afterSessionNew !== undefined;
      if (sessions && request.method === "session/new") {
        yield* send({ id: request.id, result: { sessionId: KIRO_SESSION_ID } });
        yield* Effect.forEach(afterSessionNew, sessionUpdate);
        return;
      }
      if (sessions && request.method === "session/prompt") {
        yield* sessionUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        });
        yield* send({ id: request.id, result: { stopReason: "end_turn" } });
        return;
      }
      const response =
        request.method === "initialize"
          ? { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }
          : request.method === "_kiro/config/template"
            ? { result: template }
            : { error: { code: -32601, message: `${request.method} is not scripted` } };
      yield* send({ id: request.id, ...response });
    });
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(900_000_003),
      exitCode: Deferred.await(exited),
      isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
      kill: () => terminate,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((bytes: Uint8Array) => {
        // A prompt can arrive split across writes.
        const lines = (pending + new TextDecoder().decode(bytes)).split("\n");
        pending = lines.pop() ?? "";
        return Effect.forEach(
          lines.filter((line) => line.trim().length > 0),
          reply,
        );
      }),
      stdout: Stream.fromQueue(output),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  });

/** Answers `kiro-cli` invocations by their arguments and records which ran. */
function kiroCli(
  outputs: Record<string, CliOutput>,
  template?: unknown,
  afterSessionNew?: ReadonlyArray<unknown>,
) {
  const invoked: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
    invoked.push(args);
    return args === KIRO_ACP_ARGS && (template !== undefined || afterSessionNew !== undefined)
      ? acpProcess(template, afterSessionNew)
      : Effect.succeed(processHandle(outputs[args] ?? { stdout: "", code: 127 }));
  });
  return { invoked, spawner };
}

const check = (
  outputs: Record<string, CliOutput>,
  options: { readonly template?: unknown; readonly settings?: KiroSettings } = {},
) =>
  Effect.gen(function* () {
    const cli = kiroCli(outputs, options.template);
    const snapshot = yield* checkKiroProviderStatus(options.settings ?? settings, {}).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
    );
    return { snapshot, invoked: cli.invoked };
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("KiroProvider", () => {
  it.effect.each([
    {
      label: "answers after 6 s",
      delay: "6 seconds",
      status: "ready",
      version: "2.27.0",
      message: undefined,
    },
    {
      label: "never answers",
      delay: "Infinity",
      status: "error",
      version: null,
      message: "Failed to run `kiro-cli --version`.",
    },
  ] as const)("gives `kiro-cli --version` 10 s when it $label", (row) =>
    Effect.gen(function* () {
      const fiber = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0, delay: row.delay },
        "whoami --format json": { stdout: '{"accountType":"ApiKey","email":null}\n', code: 0 },
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const { snapshot } = yield* Fiber.join(fiber);
      assert.equal(snapshot.status, row.status);
      assert.equal(snapshot.version, row.version);
      assert.equal(snapshot.message, row.message);
    }),
  );

  it.effect("reports a CLI whose version probe exits nonzero as failing to run", () =>
    Effect.gen(function* () {
      const { snapshot, invoked } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 1 },
      });
      assert.equal(snapshot.status, "error");
      assert.isTrue(snapshot.installed);
      assert.equal(snapshot.message, "Kiro CLI is installed but failed to run.");
      // A broken CLI is not asked for its sign-in.
      assert.deepEqual(invoked, ["--version"]);
    }),
  );

  // `whoami` outputs recorded from Kiro CLI 2.27.0.
  it.effect("asks for kiro-cli login when Kiro is signed out", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"account":null}\n', code: 1 },
      });
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "2.27.0");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.include(snapshot.message ?? "", "kiro-cli login");
    }),
  );

  it.effect("is ready once Kiro reports a signed-in account", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"ApiKey","email":null}\n', code: 0 },
      });
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      // The version advisory is what the compatibility check and update UI read.
      assert.equal(snapshot.versionAdvisory?.currentVersion, "2.27.0");
      assert.isFalse(snapshot.versionAdvisory?.canUpdate);
    }),
  );

  // Shape of `kiro-cli chat --list-models --format json` on Kiro CLI 2.27.0, trimmed to three models.
  const KIRO_MODEL_LIST = JSON.stringify({
    models: [
      { model_name: "auto", model_id: "auto", description: "Models chosen by task" },
      { model_name: "claude-sonnet-4.5", model_id: "claude-sonnet-4.5" },
      { model_name: "claude-haiku-4.5", model_id: "claude-haiku-4.5" },
    ],
    default_model: "auto",
  });

  it.effect("lists the signed-in account's models with auto as the Kiro default", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
        "chat --list-models --format json": { stdout: `${KIRO_MODEL_LIST}\n`, code: 0 },
      });
      assert.deepEqual(
        snapshot.models.map((model) => [model.slug, model.name, model.isDefault === true]),
        [
          ["default", "auto", true],
          ["claude-sonnet-4.5", "claude-sonnet-4.5", false],
          ["claude-haiku-4.5", "claude-haiku-4.5", false],
        ],
      );
    }),
  );

  it.effect("names Kiro default after the model Kiro's list names as its default", () =>
    Effect.gen(function* () {
      const signedIn = {
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
      };
      const listed = yield* check({
        ...signedIn,
        "chat --list-models --format json": {
          stdout: KIRO_MODEL_LIST.replace(
            '"default_model":"auto"',
            '"default_model":"claude-sonnet-4.5"',
          ),
          code: 0,
        },
      });
      assert.deepEqual(
        listed.snapshot.models.map((model) => [model.slug, model.name]),
        [
          ["auto", "auto"],
          ["default", "claude-sonnet-4.5"],
          ["claude-haiku-4.5", "claude-haiku-4.5"],
        ],
      );
      assert.equal(kiroDefaultModelId(listed.snapshot.models), "claude-sonnet-4.5");
      // An unparsable list keeps the built-in entry, which falls back to `auto`.
      const unlisted = yield* check({
        ...signedIn,
        "chat --list-models --format json": { stdout: "not json\n", code: 0 },
      });
      assert.equal(unlisted.snapshot.models[0]?.name, "Kiro default");
      assert.equal(kiroDefaultModelId(unlisted.snapshot.models), "auto");
    }),
  );

  it.effect("lists Kiro default even when Kiro's model list leaves its default out", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
        "chat --list-models --format json": {
          stdout: JSON.stringify({ models: [{ model_id: "claude-sonnet-4.5" }] }),
          code: 0,
        },
      });
      assert.deepEqual(
        snapshot.models.map((model) => [model.slug, model.name, model.isDefault === true]),
        [
          ["default", "Kiro default", true],
          ["claude-sonnet-4.5", "claude-sonnet-4.5", false],
        ],
      );
      assert.equal(kiroDefaultModelId(snapshot.models), "auto");
    }),
  );

  // `--list-models` names no effort levels, so the picker's come from Kiro's ids.
  const KIRO_EFFORT_MODEL_LIST = JSON.stringify({
    models: [
      "auto",
      "claude-fable-5.1",
      "claude-opus-5.5",
      "claude-opus-4.6",
      "kimi-k3",
      "claude-sonnet-4.5",
    ].map((id) => ({
      model_name: id,
      model_id: id,
    })),
    default_model: "auto",
  });

  it.effect("offers each model only the reasoning levels Kiro takes for it", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
        "chat --list-models --format json": { stdout: KIRO_EFFORT_MODEL_LIST, code: 0 },
      });
      const reasoning = snapshot.models.map((model) => {
        const descriptors = model.capabilities?.optionDescriptors ?? [];
        const select = descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
        return select?.type === "select"
          ? {
              slug: model.slug,
              label: select.label,
              levels: select.options.map((choice) => choice.id),
              defaults: select.options.filter((choice) => choice.isDefault).map((c) => c.id),
              currentValue: select.currentValue,
            }
          : { slug: model.slug, descriptors: descriptors.length };
      });
      assert.deepEqual(reasoning, [
        // Kiro default and models without effort get no Reasoning select.
        { slug: "default", descriptors: 0 },
        {
          slug: "claude-fable-5.1",
          label: "Reasoning",
          levels: ["low", "medium", "high", "xhigh", "max"],
          defaults: ["high"],
          currentValue: "high",
        },
        {
          slug: "claude-opus-5.5",
          label: "Reasoning",
          levels: ["low", "medium", "high", "xhigh", "max"],
          defaults: ["medium"],
          currentValue: "medium",
        },
        // Opus 4.6 has no xhigh, and Kiro runs it at high by default.
        {
          slug: "claude-opus-4.6",
          label: "Reasoning",
          levels: ["low", "medium", "high", "max"],
          defaults: ["high"],
          currentValue: "high",
        },
        // Kimi K3 skips medium and runs at max by default.
        {
          slug: "kimi-k3",
          label: "Reasoning",
          levels: ["low", "high", "max"],
          defaults: ["max"],
          currentValue: "max",
        },
        { slug: "claude-sonnet-4.5", descriptors: 0 },
      ]);
    }),
  );

  it.effect("gives every model, custom ones too, the agent picker Kiro's template lists", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check(
        {
          "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
          "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
          "chat --list-models --format json": { stdout: KIRO_MODEL_LIST, code: 0 },
        },
        {
          template: {
            configOptions: [
              {
                type: "select",
                id: "mode",
                name: "Mode",
                currentValue: "vibe",
                options: [
                  { value: "vibe", name: "Default" },
                  { value: "reviewer", name: "reviewer" },
                ],
              },
            ],
          },
          settings: { ...settings, customModels: ["my-model"] },
        },
      );
      assert.deepEqual(
        snapshot.models.map((model) => [
          model.slug,
          model.capabilities?.optionDescriptors?.flatMap((descriptor) =>
            descriptor.type === "select" && descriptor.id === "mode"
              ? descriptor.options.map((choice) => choice.id)
              : [],
          ),
        ]),
        [
          ["default", ["vibe", "reviewer"]],
          ["claude-sonnet-4.5", ["vibe", "reviewer"]],
          ["claude-haiku-4.5", ["vibe", "reviewer"]],
          ["my-model", ["vibe", "reviewer"]],
        ],
      );
    }),
  );

  it("offers Kiro's agents from its config template, Default first", () => {
    // `_kiro/config/template` from kiro-cli 2.27.0 with two user agents in
    // `~/.kiro/agents`, trimmed to three bundled agents and the `mode` option.
    const template = {
      modes: { currentModeId: "vibe", availableModes: [] },
      configOptions: [
        {
          type: "select",
          id: "mode",
          name: "Mode",
          category: "mode",
          currentValue: "vibe",
          options: [
            { value: "vibe", name: "Default", description: "General coding assistance" },
            { value: "spec", name: "Spec", description: "Structured feature development" },
            { value: "plan", name: "Plan", description: "Plan-only mode" },
            { value: "global-probe", name: "global-probe", description: "Global probe agent" },
            { value: "planner", name: "planner", description: null },
          ],
        },
        {
          type: "select",
          id: "autopilot",
          name: "Autopilot",
          currentValue: "on",
          options: [{ value: "on", name: "Autopilot" }],
        },
      ],
    };
    const descriptor = kiroAgentDescriptor(template);
    assert.deepEqual(descriptor, {
      id: "mode",
      label: "Agent",
      type: "select",
      currentValue: "vibe",
      options: [
        { id: "vibe", label: "Default", description: "General coding assistance", isDefault: true },
        { id: "spec", label: "Spec", description: "Structured feature development" },
        { id: "plan", label: "Plan", description: "Plan-only mode" },
        { id: "global-probe", label: "global-probe", description: "Global probe agent" },
        { id: "planner", label: "planner" },
      ],
    });
    // The default follows the agent Kiro starts sessions on.
    const onSpec = kiroAgentDescriptor({
      configOptions: [{ ...template.configOptions[0], currentValue: "spec" }],
    });
    assert.equal(onSpec?.type === "select" ? onSpec.currentValue : undefined, "spec");
    assert.deepEqual(
      onSpec?.type === "select" ? onSpec.options.filter((choice) => choice.isDefault) : [],
      [
        {
          id: "spec",
          label: "Spec",
          description: "Structured feature development",
          isDefault: true,
        },
      ],
    );
    // A template without agents to choose between gives no picker.
    assert.isUndefined(kiroAgentDescriptor({ configOptions: [] }));
    assert.isUndefined(kiroAgentDescriptor("not a template"));
  });

  it.effect("never lists models while signed out, where listing would start a browser login", () =>
    Effect.gen(function* () {
      const { snapshot, invoked } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"account":null}\n', code: 1 },
        "chat --list-models --format json": { stdout: `${KIRO_MODEL_LIST}\n`, code: 0 },
      });
      assert.notInclude(invoked, "chat --list-models --format json");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }),
  );

  // Shaped like kiro-cli 2.37.1's second `available_commands_update` after
  // `session/new` with `~/.kiro/skills/probe-skill/SKILL.md` installed.
  it.effect("lists the skills a Kiro session advertises", () =>
    Effect.gen(function* () {
      const cli = kiroCli(
        {
          "--version": { stdout: "kiro-cli 2.37.1\n", code: 0 },
          "whoami --format json": { stdout: "", code: 2 },
        },
        undefined,
        [
          {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              {
                name: "probe-skill",
                description: "A probe skill that checks skill discovery over ACP.",
                input: { hint: "optional context" },
                _meta: {
                  kiro: {
                    type: "skill",
                    resource: { resourceType: "skill", source: { origin: "user" } },
                    originalName: "probe-skill",
                  },
                },
              },
            ],
          },
        ],
      );
      yield* Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("kiro");
        const instance = yield* KiroDriver.create({
          instanceId,
          displayName: "Kiro",
          accentColor: undefined,
          enabled: true,
          environment: [],
          config: settings,
        });
        // Subscribed before the session opens, so the publish cannot slip past it.
        const advertised = yield* instance.snapshot.streamChanges.pipe(
          Stream.takeUntil((snapshot) =>
            snapshot.skills.some(({ name }) => name === "probe-skill"),
          ),
          Stream.runLast,
          Effect.forkChild({ startImmediately: true }),
        );
        const threadId = ThreadId.make("thread-kiro-skills");
        const modelSelection = { instanceId, model: "default" };
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const session = yield* instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-kiro-skills"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-kiro-skills"),
            title: "Kiro skills",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: runtimePolicy.runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-kiro-skills"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-kiro-skills"),
          rootNodeId: NodeId.make("node-kiro-skills"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-kiro-skills"),
            text: "Say hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        const snapshot = yield* Fiber.join(advertised);
        assert.deepEqual(
          Option.map(snapshot, ({ skills }) =>
            skills.map((skill) => ({ name: skill.name, enabled: skill.enabled })),
          ),
          Option.some([{ name: "probe-skill", enabled: true }]),
        );
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
        Effect.scoped,
      );
    }).pipe(
      Effect.provide(
        TestProviderHost.layer().pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(IdAllocator.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        ),
      ),
    ),
  );
});
