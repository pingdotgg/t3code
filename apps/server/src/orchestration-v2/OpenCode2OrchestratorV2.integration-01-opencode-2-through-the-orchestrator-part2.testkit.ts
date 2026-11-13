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

export const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";

export const FIRST_TURN_END = "first-turn-end";

export const BACKGROUND_HOLD = "background-hold";

export const BACKGROUND_PARENT = "ses_f1485cda4ffeXuc6GjAU9vDiRb";

export const BACKGROUND_CHILD = "ses_f1485c529ffea4URrYruwEg0Ja";
export const BACKGROUND_PROMPT =
  "Use the subagent tool with background enabled to delegate to the general subagent with the prompt: 'Run the shell command `sleep 20` with the bash tool and then reply exactly CHILD_OK.' As soon as it is launched, reply exactly PARENT_OK and end your turn without waiting for it.";
export const instanceId = ProviderInstanceId.make("opencode");
export const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
export const mimo: ModelSelection = { instanceId, model: "opencode/mimo-v2.6-flash-free" };

export const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
export const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
export const event = (type: string, data: Record<string, unknown>): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    type: "sdk.event",
    event: { id: `evt_${type.replaceAll(".", "")}`, created: 1, type, data },
  },
});
export const labelled = (entry: ProviderReplayEntry, label: string): ProviderReplayEntry =>
  entry.type === "runtime_exit" ? entry : { ...entry, label };
/** MCP rules are last-match-wins; allow this thread after denying all T3 servers. */
export const mcpRules = (name: string) => [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: `t3-code-thread_${name}_*`, resource: "*", effect: "allow" },
];
export const FULL_ACCESS = [{ action: "*", resource: "*", effect: "allow" }];

export const t3Rules = (name: string) => [...FULL_ACCESS, ...mcpRules(name)];

export const BUILD_PATHS = [
  {
    action: "external_directory",
    resource: "/home/.local/share/opencode/tool-output/*",
    effect: "allow",
  },
];
export const PLAN_PATHS = [
  ...BUILD_PATHS,
  { action: "edit", resource: "/home/.opencode/plan/*", effect: "allow" },
  { action: "external_directory", resource: "/home/.opencode/plan/*", effect: "allow" },
];
export const agentInfo = (id: string, description: string, permissions: ReadonlyArray<unknown>) => ({
  id,
  name: id === "plan" ? "Plan" : "Build",
  request: { settings: {}, headers: {}, body: {} },
  description,
  mode: "primary",
  hidden: false,
  permissions,
});

export const agentList = (directory: string) => ({
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

export const autoEditRules = (name: string) => [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  ...BUILD_PATHS,
  ...mcpRules(name),
];

export const planRules = (name: string) => [
  { action: "*", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  ...PLAN_PATHS,
  ...mcpRules(name),
];

export const sessionInfo = (directory: string, permissions: ReadonlyArray<unknown>, title: string) => ({
  data: {
    id: SESSION,
    title,
    projectID: "global",
    model: { id: "big-pickle", providerID: "opencode", variant: "default" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1790656601394, updated: 1790656601394 },
    location: { directory },
    permissions,
  },
});

export const instructionsWritten: ReadonlyArray<ProviderReplayEntry> = [
  out("session.instructions.entry.put", { sessionID: SESSION, key: "t3-code", value: "<any>" }),
  reply("session.instructions.entry.put", null),
];

export const answeredPrompt = (text: string): ReadonlyArray<ProviderReplayEntry> => [
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

/** A `/api/model` entry as 2.0.18 lists it; a known window means no re-read after a turn. */
export const catalogModel = (id: string, name: string) => ({
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
export const createdSession = (
  directory: string,
  name: string,
  permissions: ReadonlyArray<unknown> = t3Rules(name),

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

  out("session.create", { location: { directory }, model: "<any>", permissions, title: name }),
  reply("session.create", sessionInfo(directory, permissions, name)),
];

export const withDirectory = <T>(value: T, directory: string): T => {
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

export const threadCommands = (input: {
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

