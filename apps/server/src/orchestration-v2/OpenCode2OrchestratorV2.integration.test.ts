/**
 * OpenCode 2 through the whole orchestrator, against a replayed HTTP server:
 * the transcript fixes the order of every request the adapter sends, so a
 * request the orchestrator never lets it make fails the run.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type ProviderReplayEntry,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  OPENCODE2_HTTP_PROTOCOL,
  OpenCode2OrchestratorReplayHarness,
} from "./Adapters/OpenCode2AdapterV2.testkit.ts";
import { OPENCODE_PROVIDER } from "./Adapters/OpenCodeAdapterV2.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import type { OrchestratorV2ScenarioStep } from "./testkit/OrchestratorScenario.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";
import {
  decodeProviderReplayNdjson,
  readProviderReplayTranscript,
} from "./testkit/ReplayTranscriptNdjson.ts";
import * as IdAllocator from "./IdAllocator.ts";

const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
/** Held until the scenario releases it, so the turn is still running meanwhile. */
const FIRST_TURN_END = "first-turn-end";
const instanceId = ProviderInstanceId.make("opencode");
const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
const mimo: ModelSelection = { instanceId, model: "opencode/mimo-v2.6-flash-free" };
const nemotron: ModelSelection = { instanceId, model: "opencode/nemotron-3.5-lightning-free" };

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
const labelled = (entry: ProviderReplayEntry, label: string): ProviderReplayEntry =>
  entry.type === "runtime_exit" ? entry : { ...entry, label };
/**
 * T3's own rules after a mode's: every thread's T3 MCP server is denied, and
 * then this thread's own is allowed again (last match wins).
 */
const mcpRules = (name: string) => [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: `t3-code-thread_${name}_*`, resource: "*", effect: "allow" },
];
const FULL_ACCESS = [{ action: "*", resource: "*", effect: "allow" }];
/** Full access for the thread named `name`. */
const t3Rules = (name: string) => [...FULL_ACCESS, ...mcpRules(name)];
/** Paths the build and plan agents allow for themselves, as 2.0.18 lists them. */
const BUILD_PATHS = [
  {
    action: "external_directory",
    resource: "/home/.local/share/opencode/tool-output/*",
    effect: "allow",
  },
];
const PLAN_PATHS = [
  ...BUILD_PATHS,
  { action: "edit", resource: "/home/.opencode/plan/*", effect: "allow" },
  { action: "external_directory", resource: "/home/.opencode/plan/*", effect: "allow" },
];
const agentInfo = (id: string, description: string, permissions: ReadonlyArray<unknown>) => ({
  id,
  name: id === "plan" ? "Plan" : "Build",
  request: { settings: {}, headers: {}, body: {} },
  description,
  mode: "primary",
  hidden: false,
  permissions,
});
/** `/api/agent` trimmed to the two agents a T3 session runs. */
const agentList = (directory: string) => ({
  location: { directory },
  data: [
    agentInfo("build", "The default agent.", [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
      ...BUILD_PATHS,
    ]),
    agentInfo("plan", "Read-only agent for planning.", [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
      ...BUILD_PATHS,
      { action: "edit", resource: "*", effect: "deny" },
      ...PLAN_PATHS.slice(BUILD_PATHS.length),
    ]),
  ],
});
/** A session this runtime loads again (after a detach) waits on nothing. */
const noOpenRequests: ReadonlyArray<ProviderReplayEntry> = [
  out("permission.list", { sessionID: SESSION }),
  reply("permission.list", { data: [] }),
  out("session.form.list", { sessionID: SESSION }),
  reply("session.form.list", { data: [] }),
];
const supervisedRules = (name: string) => [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
  ...BUILD_PATHS,
  ...mcpRules(name),
];
const autoEditRules = (name: string) => [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  ...BUILD_PATHS,
  ...mcpRules(name),
];
/** Plan mode on Full access: edits are denied except the plan agent's own plan files. */
const planRules = (name: string) => [
  { action: "*", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  ...PLAN_PATHS,
  ...mcpRules(name),
];

const sessionInfo = (directory: string, permissions: ReadonlyArray<unknown>) => ({
  data: {
    id: SESSION,
    projectID: "global",
    model: { id: "big-pickle", providerID: "opencode", variant: "default" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1790656601394, updated: 1790656601394 },
    location: { directory },
    permissions,
  },
});
/** T3's instructions entry, written before a thread's first prompt and whenever it changes. */
const instructionsWritten: ReadonlyArray<ProviderReplayEntry> = [
  out("session.instructions.entry.put", { sessionID: SESSION, key: "t3-code", value: "<any>" }),
  reply("session.instructions.entry.put", null),
];
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
/** The model list read the first time a thread runs in `directory`. */
const directoryModels = (directory: string): ReadonlyArray<ProviderReplayEntry> => [
  out("model.list", { "location[directory]": directory }),
  reply("model.list", {
    location: { directory },
    data: [
      catalogModel("big-pickle", "Big Pickle"),
      catalogModel("mimo-v2.6-flash-free", "MiMo V2.6 Flash Free"),
    ],
  }),
];
/** A `/api/model` entry as 2.0.18 lists it; a known window means no re-read after a turn. */
const catalogModel = (id: string, name: string) => ({
  id,
  modelID: id,
  providerID: "opencode",
  family: id,
  name,
  compatibility: { reasoningField: "reasoning_content" },
  package: "@opencode/ai/providers/openai-compatible",
  settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 1760659200000 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled: true,
  limit: { context: 200000, input: 160000, output: 32000 },
});
const createdSession = (
  directory: string,
  name: string,
  permissions: ReadonlyArray<unknown> = t3Rules(name),
  // Only a mode that narrows Full access reads the agents' own path rules.
  narrows = false,
): ReadonlyArray<ProviderReplayEntry> => [
  out("event.subscribe"),
  out("model.list", "<any>"),
  reply("model.list", {
    location: { directory },
    data: [
      catalogModel("big-pickle", "Big Pickle"),
      catalogModel("mimo-v2.6-flash-free", "MiMo V2.6 Flash Free"),
    ],
  }),
  ...(narrows ? [out("agent.list", "<any>"), reply("agent.list", agentList(directory))] : []),
  out("session.create", { location: { directory }, model: "<any>", permissions }),
  reply("session.create", sessionInfo(directory, permissions)),
];

/** A recording with its scrubbed `<work>` directory replaced by `directory`. */
const withDirectory = <T>(value: T, directory: string): T => {
  const replace = (entry: unknown): unknown =>
    entry === "<work>"
      ? directory
      : Array.isArray(entry)
        ? entry.map(replace)
        : typeof entry === "object" && entry !== null
          ? Object.fromEntries(Object.entries(entry).map(([key, inner]) => [key, replace(inner)]))
          : entry;
  return replace(value) as T;
};

const threadCommands = (input: {
  readonly name: string;
  readonly worktreePath: string;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
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
      interactionMode: input.interactionMode ?? "default",
      branch: null,
      worktreePath: input.worktreePath,
    } satisfies OrchestrationV2Command,
    message: (key: string, modelSelection: ModelSelection = bigPickle, text?: string) =>
      ({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: command(key),
        threadId,
        messageId: MessageId.make(`message:${input.name}:${key}`),
        text: text ?? `Reply with exactly: ${key}`,
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      }) satisfies OrchestrationV2Command,
    interactionMode: (key: string, interactionMode: "default" | "plan") =>
      ({
        type: "thread.interaction-mode.set",
        commandId: command(key),
        threadId,
        interactionMode,
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
              ...createdSession(cwd, name),
              ...instructionsWritten,
              ...answeredPrompt("FIRST"),
              // The next turn resumes the session at its new selection.
              out("session.get", { sessionID: SESSION }),
              reply("session.get", sessionInfo(cwd, t3Rules(name))),
              out("session.switchModel", {
                sessionID: SESSION,
                model: { providerID: "opencode", id: "mimo-v2.6-flash-free" },
              }),
              reply("session.switchModel", null),
              // The instructions name the model, so they are written again.
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
          ...createdSession(before, name),
          ...instructionsWritten,
          ...answeredPrompt("FIRST"),
          ...directoryModels(after),
          out("session.get", { sessionID: SESSION }),
          reply("session.get", sessionInfo(before, t3Rules(name))),
          // The worktree change detached the thread, so its session is loaded afresh.
          ...noOpenRequests,
          out("session.move", { sessionID: SESSION, directory: after }),
          reply("session.move", null),
          // The moved thread reopens its session, which writes the entry again.
          ...instructionsWritten,
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

  it.effect("gives a session made with older rules T3's rules before its next prompt", () =>
    Effect.gen(function* () {
      const name = "opencode2-resume-rules";
      const before = yield* checkpointWorkspace(`${name}-before`);
      const after = yield* checkpointWorkspace(`${name}-after`);
      const thread = threadCommands({ name, worktreePath: before });
      const projection = yield* runScenario({
        name,
        threadId: thread.threadId,
        entries: [
          ...createdSession(before, name),
          ...instructionsWritten,
          ...answeredPrompt("FIRST"),
          ...directoryModels(after),
          // Reopened after a worktree change, the session reports the rules an
          // older build gave it, which denied subagents; they are replaced
          // before anything runs.
          out("session.get", { sessionID: SESSION }),
          reply(
            "session.get",
            sessionInfo(before, [
              { action: "*", resource: "*", effect: "allow" },
              { action: "subagent", resource: "*", effect: "deny" },
            ]),
          ),
          ...noOpenRequests,
          out("session.update", { sessionID: SESSION, permissions: t3Rules(name) }),
          reply("session.update", null),
          out("session.move", { sessionID: SESSION, directory: after }),
          reply("session.move", null),
          ...instructionsWritten,
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
    }).pipe(Effect.scoped),
  );

  it.effect(
    "creates a Supervised thread's session with rules that ask before shell and edits",
    () =>
      Effect.gen(function* () {
        const name = "opencode2-supervised-rules";
        const cwd = yield* checkpointWorkspace(name);
        const thread = threadCommands({
          name,
          worktreePath: cwd,
          runtimeMode: "approval-required",
        });
        const projection = yield* runScenario({
          name,
          threadId: thread.threadId,
          entries: [
            ...createdSession(cwd, name, supervisedRules(name), true),
            ...instructionsWritten,
            ...answeredPrompt("FIRST"),
          ],
          commands: [thread.create, thread.message("first")],
        });
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed"],
        );
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
          // A mode change detaches nothing: the same session is resumed with the new rules.
          out("session.get", { sessionID: SESSION }),
          reply("session.get", sessionInfo(cwd, t3Rules(name))),
          out("agent.list", "<any>"),
          reply("agent.list", agentList(cwd)),
          out("session.update", { sessionID: SESSION, permissions: autoEditRules(name) }),
          reply("session.update", null),
          ...answeredPrompt("SECOND"),
          // Back to Full access: the narrowing rules go.
          out("session.get", { sessionID: SESSION }),
          reply("session.get", sessionInfo(cwd, autoEditRules(name))),
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
          // Plan mode is also OpenCode's plan agent, switched before the prompt.
          out("session.switchAgent", { sessionID: SESSION, agent: "plan" }),
          reply("session.switchAgent", null),
          ...instructionsWritten,
          ...answeredPrompt("PLANNED"),
          out("session.get", { sessionID: SESSION }),
          reply("session.get", sessionInfo(cwd, planRules(name))),
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
      // The recording scrubbed its directory to `<work>`; the fork it answers
      // runs where its source does, which is this test's workspace.
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
      // The fork keeps the first turn and drops the second: the model answers
      // from the first alone, and T3 shows the inherited turn but not the other.
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
      // The first turn is held open until the queue has been changed: its end
      // is the last event, after the cancel.
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
          // Only the third message reaches OpenCode, as the next turn.
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

  it.effect(
    "runs plan mode as OpenCode's plan agent and switches back before the next prompt",
    () =>
      Effect.gen(function* () {
        const name = "opencode2_switch";
        const cwd = yield* checkpointWorkspace(name);
        const thread = threadCommands({ name, worktreePath: cwd });
        // The spike's recording: plan agent, then build agent and a new model on
        // one session. Its `<work>` is this test's workspace.
        const recorded = yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const text = yield* fs.readFileString(
            yield* path.fromFileUrl(
              new URL(
                "./testkit/fixtures/opencode2_switch/opencode_transcript.ndjson",
                import.meta.url,
              ),
            ),
          );
          return yield* decodeProviderReplayNdjson(text.replaceAll("<work>", cwd));
        }).pipe(Effect.provide(NodeServices.layer));
        const projection = yield* runScenario({
          name,
          threadId: thread.threadId,
          entries: recorded.entries,
          commands: [
            thread.create,
            thread.interactionMode("mode-plan", "plan"),
            thread.message(
              "plan",
              bigPickle,
              "Create a file named plan_probe.txt containing HI using the write tool.",
            ),
            thread.interactionMode("mode-default", "default"),
            thread.message("switched", nemotron, "Reply exactly SWITCHED."),
          ],
        });
        assert.deepEqual(
          projection.runs.map((run) => [run.status, run.modelSelection.model]),
          [
            ["completed", bigPickle.model],
            ["completed", nemotron.model],
          ],
        );
        const replies = projection.turnItems.flatMap((item) =>
          item.type === "assistant_message" ? [item.text] : [],
        );
        // The plan agent refused to write; OpenCode's own reminder told it why.
        assert.include(replies[0], "Plan mode");
        assert.equal(replies[1], "SWITCHED");
        assert.lengthOf(projection.providerThreads, 1);
      }).pipe(Effect.scoped),
  );
});
