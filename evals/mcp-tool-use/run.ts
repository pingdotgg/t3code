#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Replays small fake threads on a Claude or Codex model to check T3's MCP tool use. A trimmed
 * harness capture supplies the prompt and native tools; a cheap model plays the shell. See
 * README.md for how to run it and add cases.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeVM from "node:vm";
import * as NodeZlib from "node:zlib";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ComposerContextRecord,
  DeviceOperationError,
  DeviceSummary,
  OrchestratorMcpTaskRole,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Tool } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { taskPrompt } from "../../apps/server/src/mcp/delegatedTaskModes.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import {
  EnvironmentId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  PullRequestState,
  ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { buildCodexAdditionalContext } from "../../apps/server/src/provider/CodexDeveloperInstructions.ts";
import { makeSideChatContext } from "../../apps/server/src/orchestration-v2/ContextHandoffService.ts";
import { withInlineContext } from "../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts";
import { AttachmentToolkit } from "../../apps/server/src/mcp/toolkits/attachment/tools.ts";
import { DeviceToolkit } from "../../apps/server/src/mcp/toolkits/device/tools.ts";
import { EnvironmentToolkit } from "../../apps/server/src/mcp/toolkits/environment/tools.ts";
import { HtmlToolkit } from "../../apps/server/src/mcp/toolkits/html/tools.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../../apps/server/src/mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../../apps/server/src/mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../../apps/server/src/mcp/toolkits/project/tools.ts";
import {
  CHILD_PULL_REQUEST_REPORT_NEXT,
  PullRequestsToolkit,
} from "../../apps/server/src/mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../../apps/server/src/mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../../apps/server/src/mcp/toolkits/worktree/tools.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { proxyConfig } from "../shared/proxy.ts";
import { changeRequestsCreatedBy } from "../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts";
import { DeviceExpect, gradeDevice } from "./device-grading.ts";
import {
  AGENT_DEVICE_SHELL,
  deviceFailure,
  type DeviceTools,
  isDeviceTool,
  launcherHelp,
  makeDeviceTools,
} from "./devices.ts";
/** Agent models by id, with the display name a harness gives them. */
const MODELS = {
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-astra": "GPT-6 Astra",
} as const;
type Model = keyof typeof MODELS;
/** GPT models replay a Codex capture through CLIProxyAPI, the rest a Claude Code capture. */
const isCodex = (model: Model): model is Extract<Model, `gpt-${string}`> =>
  model.startsWith("gpt-");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// USD per million tokens. Cache writes use the 5-minute rate.
const PRICES = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
type PricedModel = keyof typeof PRICES;
const T3_PREFIX = "mcp__t3-code__";
const RUNTIME_MARKER = "<runtime_info>";
const TOOL_LOADED = "Tool loaded.";
const DEFERRED_LIST =
  /(The following deferred tools are now available via ToolSearch\.[^\n]*\n)((?:[^\n]+\n)*)/;
const MODEL_LINE = /You are powered by the model named .+?\. The exact model ID is [\w.-]+\./;
// API keys can be billed differently for requests that open with Claude Code's identity line,
// so every copy of it becomes a neutral line. The rest of the captured prompt is unchanged.
const IDENTITY =
  /You are Claude Code, Anthropic's official CLI for Claude(?:, running within the Claude Agent SDK)?\./g;
const NEUTRAL_IDENTITY = "You are an AI coding agent running in the user's terminal.";

type Block = { readonly type: string; readonly [key: string]: unknown };
type ApiMessage = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };
type ApiTool = { readonly name: string; readonly [key: string]: unknown };
type Usage = Record<keyof (typeof PRICES)[PricedModel], number>;
type Call = {
  readonly step: number;
  readonly tool: string;
  readonly input: unknown;
  /** The tool_use id, when the call was a tool use of its own. */
  readonly id?: string;
  /** Once answered: whether the agent saw an error, and the result text it saw. */
  failed?: boolean;
  output?: string;
};
export type SampleRun = {
  readonly calls: ReadonlyArray<Call>;
  text: string;
  stopReason: string;
  /** The agent's final answer: its last response's text, if it ended its turn. */
  readonly finalText?: string;
  /** PRs linked to the thread when the sample ends, by the agent or by T3. */
  readonly linked?: ReadonlyArray<string>;
  /** The `agent-device` commands T3's device_open returned, prior turns included. */
  readonly launchers?: ReadonlyArray<string>;
};

const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

const PriorToolCall = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  /** For a device tool, `"default"` runs the call on the world's devices for T3's result. */
  result: Schema.Unknown,
});

/**
 * One expected call. `args` match partially: `~text` is a case-insensitive substring,
 * `"<=N"` / `">=N"` bound a number, and keys may be dotted paths.
 */
const McpToolUseCall = Schema.Struct({
  tool: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type McpToolUseCall = typeof McpToolUseCall.Type;

/** Grading rules. Tool names are bare: `delegate_task`, `Bash`, `Agent`. */
const McpToolUseExpect = Schema.Struct({
  /** Each entry needs one matching call. */
  calls: Schema.optional(Schema.Array(McpToolUseCall)),
  /** No call may match any entry. */
  callsMustNot: Schema.optional(Schema.Array(McpToolUseCall)),
  notCalls: Schema.optional(Schema.Array(Schema.String)),
  /** First calls of these tools happen in this order. */
  order: Schema.optional(Schema.Array(Schema.String)),
  minCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  maxCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  /** The last step with tool calls includes this tool, then the turn ends. */
  endsTurnAfter: Schema.optional(Schema.String),
  /** Regexes that no shell command may match. */
  shellMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Case-sensitive regexes on the agent's visible text. */
  textMust: Schema.optional(Schema.Array(Schema.String)),
  textMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Each entry matches a PR URL linked at the end, as `args` values match. */
  linked: Schema.optional(Schema.Array(Schema.String)),
  /** The PR numbers linked at the end, exactly. */
  linkedNumbers: Schema.optional(Schema.Array(Schema.Number)),
  /** Device manager checks: child briefs, simulator UI over the shell, failures, recordings. */
  device: Schema.optional(DeviceExpect),
});

/**
 * The agent's machine, as the shell simulator and the gitStatus reminder see it. Only these keys
 * are typed; others (files, diff, prs, pages) are free-form facts for the simulator.
 */
const McpToolUseWorld = Schema.StructWithRest(
  Schema.Struct({
    /** GitHub `owner/name`. Defaults to `acme/app`. */
    repo: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    /** `git status --short` lines. */
    status: Schema.optional(Schema.String),
    /** Newest first. On a branch other than main, these are the commits main lacks. */
    commits: Schema.optional(
      Schema.Array(
        Schema.StructWithRest(Schema.Struct({ sha: Schema.String, subject: Schema.String }), Rest),
      ),
    ),
    /** Simulators and emulators. With them, T3's device tools answer from this world. */
    devices: Schema.optional(Schema.Array(DeviceSummary)),
    /** Labels of the SSH device hosts in `devices`, by id. The local host always exists. */
    deviceHosts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    /**
     * agent-device sessions that prior turns started, by device id, with the app `open` put in
     * each. Otherwise a device's session starts at its launcher's first `open` in the sample.
     */
    agentDeviceSessions: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ app: Schema.optional(Schema.String) })),
    ),
    /**
     * Hosts whose hub fails to list devices, by id, with the error, such as F1's
     * `{"_tag": "DeviceOperationError", "operation": "list", "reason": "request_failed", "cause": null}`.
     * T3 marks each one failed on every call and lists none of its devices.
     */
    deviceDiscoveryFailures: Schema.optional(Schema.Record(Schema.String, DeviceOperationError)),
    /** false: agent device access is off. T3 denies every device call and drops its device text. */
    deviceAgentAccess: Schema.optional(Schema.Boolean),
    /** Every capture reaches T3 with adb screencap's warning ahead of the PNG: T3 reports 0×0. */
    deviceInvalidCapture: Schema.optional(Schema.Boolean),
    /** Devices another thread's agent-device session holds, by device id: that thread's id. */
    deviceOwners: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    /** PRs already linked to the thread, with the state T3 last saw. */
    linkedPullRequests: Schema.optional(
      Schema.Array(
        Schema.Struct({ number: Schema.Number, state: PullRequestState, title: Schema.String }),
      ),
    ),
  }),
  Rest,
);

/** One fake thread, one JSON object per line in a case file. */
export const McpToolUseCase = Schema.Struct({
  id: Schema.String,
  area: Schema.String,
  kind: Schema.Literals(["bad", "guard", "control"]),
  pattern: Schema.String,
  experience: Schema.String,
  rule: Schema.optional(Schema.String),
  privacy: Schema.optional(Schema.Literals(["commit-safe", "private"])),
  setup: Schema.Struct({
    role: Schema.Literals(["top", "delegated-child", "native-subagent"]),
    /** Runs only on this harness, for cases whose right answer depends on it. */
    harness: Schema.optional(Schema.Literals(["claude", "codex"])),
    /** The Linked environments beta is on, so T3 lists its link tools. */
    linkedEnvironments: Schema.optional(Schema.Boolean),
    /** delegate_task `role` for a delegated child. T3 builds the child's first message from it. */
    delegateRole: Schema.optional(OrchestratorMcpTaskRole),
    context: Schema.optional(Schema.String),
    priorTurns: Schema.optional(
      Schema.Array(
        Schema.Struct({
          role: Schema.Literals(["user", "assistant"]),
          text: Schema.optional(Schema.String),
          toolCalls: Schema.optional(Schema.Array(PriorToolCall)),
        }),
      ),
    ),
    world: Schema.optional(McpToolUseWorld),
    /**
     * Canned tool results by bare name, T3 or native. `"default"` uses the runner's result. For a
     * device tool, a T3 `DeviceError` (`{"_tag": ..., "cause": null}`) fails it inside T3.
     */
    mocks: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    /** Regexes on one part of a shell command. A match wins over the shell simulator. */
    shellMocks: Schema.optional(
      Schema.Array(Schema.Struct({ match: Schema.String, output: Schema.String })),
    ),
    /** The thread is a side chat's first turn: T3 puts the parent's digest ahead of `prompt`. */
    sideChat: Schema.optional(
      Schema.Struct({ parentThreadId: Schema.String, digest: Schema.Array(Schema.String) }),
    ),
  }),
  prompt: Schema.String,
  /** Records for the context chips `prompt` links, projected as T3 sends them. */
  promptContext: Schema.optional(Schema.Struct({ records: Schema.Array(ComposerContextRecord) })),
  expect: McpToolUseExpect,
  /** Model calls this case may need. Overrides `--max-steps`. */
  maxSteps: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  notes: Schema.optional(Schema.String),
});
export type McpToolUseCase = typeof McpToolUseCase.Type;
const AnyBlock = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  Rest,
);
const Content = Schema.Union([Schema.String, Schema.Array(AnyBlock)]);
const MessagesRequest = Schema.Struct({
  system: Schema.optional(Content),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })),
  tools: Schema.Array(Schema.StructWithRest(Schema.Struct({ name: Schema.String }), Rest)),
});
// A CLIProxyAPI capture keeps the Anthropic body at request.provider_native.
const Capture = Schema.Struct({ request: Schema.Struct({ provider_native: MessagesRequest }) });
const ResponsesRequest = Schema.StructWithRest(
  Schema.Struct({
    input: Schema.Array(AnyBlock),
    reasoning: Schema.StructWithRest(Schema.Struct({ effort: Schema.String }), Rest),
  }),
  Rest,
);
const CodexCapture = Schema.Struct({
  request: Schema.Struct({ provider_native: ResponsesRequest }),
});
const ToolUse = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
const isToolUse = Schema.is(ToolUse);
const isText = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const Count = Schema.optional(Schema.NullOr(Schema.Number));
const ApiResponse = Schema.Struct({
  content: Schema.Array(AnyBlock),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_creation_input_tokens: Count,
    cache_read_input_tokens: Count,
  }),
});

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const addUsage = (total: Usage, usage: typeof ApiResponse.Type.usage) => {
  total.input += usage.input_tokens;
  total.output += usage.output_tokens;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
};

const text = (value: string): Block => ({ type: "text", text: value });
const reminder = (value: string) => text(`<system-reminder>\n${value}\n</system-reminder>`);
const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
const toolResult = (id: string, content: unknown): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: valueText(content),
});
const texts = (content: typeof Content.Type) =>
  typeof content === "string" ? [content] : content.flatMap((block) => block.text ?? []);
const isT3Name = (name: string) => name.startsWith(T3_PREFIX) || name.startsWith("mcp__t3_code__");
const hasTool = (tools: ReadonlyArray<ApiTool>, name: string) =>
  tools.some((tool) => tool.name === name);

/** Grading name: T3 tools lose their MCP prefix, native tools keep the part after the last `_`. */
const CODEX_NAMES: Readonly<Record<string, string>> = {
  exec_command: "Bash",
  shell_command: "Bash",
  shell: "Bash",
  spawn_agent: "Agent",
  apply_patch: "Edit",
  write_stdin: "write_stdin",
  web__run: "WebFetch",
};
export const normalizeToolName = (name: string) => {
  const bare = name.slice(name.lastIndexOf(".") + 1);
  return isT3Name(bare)
    ? bare.slice(T3_PREFIX.length)
    : (CODEX_NAMES[bare] ?? bare.slice(bare.lastIndexOf("_") + 1));
};
export const normalizeToolInput = (name: string, input: unknown) =>
  normalizeToolName(name) === "Bash" && isRecord(input)
    ? { ...input, command: input.command ?? input.cmd }
    : typeof input === "string" && normalizeToolName(name) === "Edit"
      ? { patch: input }
      : input;

// McpHttpServer advertises each tool's JSON schema, and Claude Code passes the MCP name,
// description, and schema through unchanged.
const t3SourceTools: ReadonlyArray<Tool.Any> = [
  OrchestratorToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  WorktreeToolkit,
  PullRequestsToolkit,
  PreviewToolkit,
  DeviceToolkit,
  HtmlToolkit,
].flatMap((toolkit): ReadonlyArray<Tool.Any> => Object.values(toolkit.tools));
const t3Tools: ReadonlyArray<ApiTool> = t3SourceTools.map((tool) => ({
  name: `${T3_PREFIX}${tool.name}`,
  description: Tool.getDescription(tool) ?? "",
  input_schema: advertisedJsonSchema(tool),
}));
const enabledWhen = (predicate: () => boolean) =>
  new Set(
    t3SourceTools
      .filter(
        (tool) => Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen) === predicate,
      )
      .map((tool) => `${T3_PREFIX}${tool.name}`),
  );
// T3 does not offer these to a delegated child, so its harness never lists them.
const hiddenFromSubagents = enabledWhen(McpInvocationContext.hiddenFromSubagents);
// The Linked environments beta starts off, and T3 lists its tools only while it is on.
const hiddenWhileLinksOff = enabledWhen(McpInvocationContext.hiddenWhileLinksOff);
const visibleT3Tools = (options: { readonly subagent?: boolean; readonly links?: boolean }) =>
  t3Tools.filter(
    (tool) =>
      (options.links === true || !hiddenWhileLinksOff.has(tool.name)) &&
      !(options.subagent === true && hiddenFromSubagents.has(tool.name)),
  );

/**
 * T3's Claude Code options for an eval thread: its system prompt append and its hooks. `device` says
 * whether the thread holds the `device` capability, as agent device access decides.
 */
const claudeQueryOptions = (model: Model, device = true) => {
  // Refs whose device text follows the capability read deviceToolsAvailable; older ones ignore it.
  const input: Parameters<typeof makeClaudeQueryOptions>[0] & {
    readonly deviceToolsAvailable?: boolean;
  } = {
    modelSelection: { instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER), model },
    nativeThreadId: "mcp-tool-use-eval",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
    deviceToolsAvailable: device,
  };
  return makeClaudeQueryOptions(input);
};

/** Text T3 appends to Claude Code's system prompt. Delegated children get the same text. */
export const t3SystemAppend = (model: Model, device = true) => {
  const { systemPrompt } = claudeQueryOptions(model, device);
  if (isRecord(systemPrompt) && systemPrompt.type === "preset" && systemPrompt.append) {
    return systemPrompt.append;
  }
  throw new Error("makeClaudeQueryOptions no longer appends T3 text to a preset prompt.");
};

/**
 * The context T3's SubagentStart hooks give a native subagent, which gets none of the append.
 * Empty when T3 registers no such hook.
 */
export const t3SubagentContext = async (model: Model, device = true) => {
  const hooks = (claudeQueryOptions(model, device).hooks?.SubagentStart ?? []).flatMap(
    (m) => m.hooks,
  );
  const input = {
    hook_event_name: "SubagentStart" as const,
    session_id: "mcp-tool-use-eval",
    transcript_path: "",
    cwd: "",
    agent_id: "mcp-tool-use-eval",
    agent_type: "general-purpose",
  };
  const outputs = await Promise.all(
    hooks.map((hook) => hook(input, undefined, { signal: AbortSignal.timeout(10_000) })),
  );
  return outputs
    .flatMap((output) =>
      "hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "SubagentStart"
        ? [output.hookSpecificOutput.additionalContext ?? ""]
        : [],
    )
    .filter(Boolean)
    .join("\n\n");
};

/**
 * Size of the context T3 adds: the system text every Claude thread gets, and the tool
 * descriptions and schemas (loaded on demand here, sent up front by harnesses without
 * deferred tools). Tokens are estimated at 4 characters each.
 */
const t3ContextReport = (model: Model) => {
  const size = (chars: number) => `${chars} chars (~${Math.round(chars / 4)} tokens)`;
  const descriptions = t3Tools.reduce((sum, tool) => sum + valueText(tool.description).length, 0);
  const schemas = JSON.stringify(t3Tools).length;
  return [
    `- T3 context: system text ${size((isCodex(model) ? JSON.stringify(buildCodexAdditionalContext({ model }, { browser: true, device: true })) : t3SystemAppend(model)).length)}`,
    `tool descriptions ${size(descriptions)}`,
    `full tool schemas ${size(schemas)} across ${t3Tools.length} tools.`,
  ].join(", ");
};

const stringProperty = (description: string) => ({ type: "string", description });
const NATIVE_SCHEMAS: Readonly<Record<string, Omit<ApiTool, "name">>> = {
  WebFetch: {
    description: "Fetches content from a URL and answers the prompt about it.",
    input_schema: {
      type: "object",
      properties: {
        url: stringProperty("The URL to fetch"),
        prompt: stringProperty("What to extract"),
      },
      required: ["url", "prompt"],
    },
  },
  WebSearch: {
    description: "Searches the web and returns result titles, links, and snippets.",
    input_schema: {
      type: "object",
      properties: { query: stringProperty("The search query") },
      required: ["query"],
    },
  },
};

/** Rebuilds the parts of a captured request that every case shares. */
export const buildBase = (
  template: typeof MessagesRequest.Type,
  options: {
    readonly model: Model;
    readonly keepUserInstructions: boolean;
    readonly subagent?: boolean;
    readonly links?: boolean;
    /** A native subagent starts from its task: T3 appends nothing to its system prompt. */
    readonly nativeSubagent?: boolean;
    /** false: the thread has no agent device access, so T3's text leaves devices out. */
    readonly deviceAccess?: boolean;
  },
) => {
  const t3 = visibleT3Tools(options);
  const firstAssistant = template.messages.findIndex((message) => message.role === "assistant");
  const head = template.messages.slice(0, firstAssistant === -1 ? undefined : firstAssistant);
  const systemTexts = [
    template.system ?? [],
    ...head.flatMap((m) => (m.role === "system" ? [m.content] : [])),
  ]
    .flatMap(texts)
    .filter((value) => !value.startsWith("x-anthropic-billing-header:"));
  const deferredList = DEFERRED_LIST.exec(systemTexts.join("\n"))?.[2];
  if (systemTexts.filter((value) => value.includes(RUNTIME_MARKER)).length !== 1 || !deferredList) {
    throw new Error(`The template needs one ${RUNTIME_MARKER} block and a deferred tool list.`);
  }
  const nativeDeferred = deferredList.split("\n").filter((name) => name && !isT3Name(name));
  const names = [...nativeDeferred, ...t3.map((tool) => tool.name)].toSorted().join("\n");
  const { model } = options;
  const append = options.nativeSubagent ? "" : t3SystemAppend(model, options.deviceAccess);
  const modelLine = `You are powered by the model named ${MODELS[model]}. The exact model ID is ${model}.`;
  const joined = systemTexts.join("\n");
  // The capture's home directory names its user. Cases use `/home/user` paths instead.
  const cwd = /Primary working directory: (\S+)/.exec(joined)?.[1] ?? "/home/user/app";
  const home = /^\/(?:home|Users)\/[^/]+/.exec(cwd)?.[0];
  const anonymize = (value: string) =>
    home === undefined ? value : value.replaceAll(home, home.replace(/[^/]+$/, "user"));
  const system = systemTexts.map((value) => {
    // T3's append is the tail of its block: runtime info, PR linking, then orchestration.
    const at = value.indexOf(RUNTIME_MARKER);
    return anonymize(at === -1 ? value : value.slice(0, at) + append)
      .replace(DEFERRED_LIST, (_, header: string) => `${header}${names}\n`)
      .replace(MODEL_LINE, modelLine)
      .replace(IDENTITY, NEUTRAL_IDENTITY);
  });
  const [first] = template.messages;
  // The last block is the captured prompt.
  const reminders = (first?.role === "user" ? texts(first.content).slice(0, -1) : []).filter(
    (value) =>
      options.keepUserInstructions || !value.includes("Codebase and user instructions are"),
  );
  // gitStatus names a real repo state. Each case gets one built from its fake world instead.
  const gitStatusAt = reminders.findIndex((value) => value.includes("# gitStatus"));
  // Claude Code sends no schema for tools it only names. Web tools get their usual one, the
  // rest load open.
  const open = { type: "object", additionalProperties: true };
  const nativeSchema = (name: string) =>
    NATIVE_SCHEMAS[name] ?? { description: name, input_schema: open };
  return {
    model,
    system: system.map(text),
    reminders: reminders.filter((_, i) => i !== gitStatusAt).map((value) => text(anonymize(value))),
    gitStatusAt: gitStatusAt === -1 ? reminders.length : gitStatusAt,
    /** The shell simulator's cwd and OS follow the template's environment section. */
    environment: {
      cwd: anonymize(cwd),
      platform: /Platform: (\w+)/.exec(joined)?.[1] ?? "linux",
      date: /Today's date is ([\d-]+)/.exec(reminders.join("\n"))?.[1],
    },
    nativeTools: template.tools.filter((tool) => !isT3Name(tool.name)),
    /** Tools ToolSearch loads: T3 tools from source, and native tools the template only names. */
    t3,
    deferred: [...t3, ...nativeDeferred.map((name) => ({ name, ...nativeSchema(name) }))],
  };
};

type Base = ReturnType<typeof buildBase> & {
  readonly codex?: typeof ResponsesRequest.Type;
  /** What T3's SubagentStart hooks give a native subagent. */
  readonly subagentContext?: string;
};

/** Keep the captured harness prompt and tools; replace app-owned context and the real user. */
const buildCodexBase = (
  template: typeof ResponsesRequest.Type,
  options: {
    readonly model: Model;
    readonly keepUserInstructions: boolean;
    readonly effort?: string | undefined;
    readonly subagent?: boolean;
    readonly links?: boolean;
    /** false: the thread has no agent device access, so T3's text leaves devices out. */
    readonly deviceAccess?: boolean;
  },
): Base => {
  const t3 = visibleT3Tools(options);
  const contentText = (item: Block) =>
    Array.isArray(item.content)
      ? item.content.map((block: Block) => valueText(block.text)).join("\n")
      : valueText(item.content);
  const joined = template.input.map(contentText).join("\n");
  if (!joined.includes("<t3_code_runtime>"))
    throw new Error("Codex template needs full T3 context.");
  const cwd = /<cwd>(.*?)<\/cwd>/.exec(joined)?.[1] ?? "/home/user/app";
  const home = /^\/(?:home|Users)\/[^/]+/.exec(cwd)?.[0];
  const clean = (s: string) => (home ? s.replaceAll(home, home.replace(/[^/]+$/, "user")) : s);
  const effort = options.effort ?? template.reasoning.effort;
  const message = (value: string, role = "developer") => ({
    type: "message",
    role,
    content: [{ type: "input_text", text: value }],
  });
  // The captured <collaboration_mode> message stays: Codex supplies its own mode text natively.
  const input = template.input.flatMap((item) => {
    const content = contentText(item);
    if (content.includes("<t3_code_")) return [];
    if (item.role === "user") {
      const env = /<environment_context>[\s\S]*?<\/environment_context>/.exec(content)?.[0];
      return env ? [message(clean(options.keepUserInstructions ? content : env), "user")] : [];
    }
    // Only harness messages and tools. A captured turn's answers and tool calls would leak into
    // every case.
    if (item.type !== "message" && item.type !== "additional_tools") return [];
    if (item.role === "assistant") return [];
    return [JSON.parse(clean(JSON.stringify(item))) as Block];
  });
  const context = buildCodexAdditionalContext(
    { model: options.model, reasoningEffort: effort },
    { browser: true, device: options.deviceAccess ?? true },
  );
  input.push(
    ...Object.entries(context).map(([key, entry]) => message(`<${key}>${entry.value}</${key}>`)),
  );
  const nativeTools = input
    .flatMap((item) =>
      item.type === "additional_tools" && Array.isArray(item.tools)
        ? item.tools.flatMap((ns: unknown) =>
            isRecord(ns) && Array.isArray(ns.tools) ? ns.tools : [],
          )
        : [],
    )
    .filter((tool): tool is ApiTool => isRecord(tool) && typeof tool.name === "string");
  if (!nativeTools.some((tool) => tool.name === "exec"))
    throw new Error("Codex template needs code-mode exec.");
  return {
    model: options.model,
    system: [],
    reminders: [],
    gitStatusAt: 0,
    environment: {
      cwd: clean(cwd),
      platform: cwd.startsWith("/Users/") ? "darwin" : "linux",
      date: /<current_date>(.*?)<\/current_date>/.exec(joined)?.[1],
    },
    nativeTools,
    t3,
    deferred: [...t3],
    codex: { ...template, input, reasoning: { ...template.reasoning, effort } },
  };
};

/** Replay prior calls in Codex's wire format, including Claude-shaped file operations. */
const codexCall = (name: string, input: unknown) => {
  const args = isRecord(input) ? input : {};
  if (name === "Bash")
    return `text(await tools.exec_command(${JSON.stringify({ ...args, cmd: args.command })}));`;
  if (["Read", "Write", "Edit"].includes(name)) {
    const file = valueText(args.file_path);
    const command =
      name === "Read"
        ? `cat ${JSON.stringify(file)}`
        : name === "Write"
          ? `cat > ${JSON.stringify(file)} <<'EVAL_EOF'\n${valueText(args.content)}\nEVAL_EOF`
          : `python3 -c ${JSON.stringify(`from pathlib import Path; p=Path(${JSON.stringify(file)}); p.write_text(p.read_text().replace(${JSON.stringify(args.old_string)}, ${JSON.stringify(args.new_string)}))`)}`;
    return `text(await tools.exec_command(${JSON.stringify({ cmd: command })}));`;
  }
  return `text(await tools.${name.replace("mcp__t3-code__", "mcp__t3_code__")}(${JSON.stringify(input)}));`;
};
const codexMessages = (messages: ReadonlyArray<ApiMessage>): Array<Block> =>
  messages.flatMap((message) =>
    message.content.map((block): Block =>
      block.type === "tool_use"
        ? {
            type: "custom_tool_call",
            call_id: block.id,
            name: "exec",
            input: codexCall(valueText(block.name), block.input),
          }
        : block.type === "tool_result"
          ? {
              type: "custom_tool_call_output",
              call_id: block.tool_use_id,
              output: valueText(block.content),
            }
          : {
              type: "message",
              role: message.role,
              content: [
                {
                  type: message.role === "user" ? "input_text" : "output_text",
                  text: valueText(block.text),
                },
              ],
            },
    ),
  );
/** One tool call the shell simulator has answered, or one from the case's prior turns. */
type ShellEntry = { readonly tool: string; readonly input: unknown; readonly output: string };
/** PRs T3 links by itself because a shell command created them, as `gh pr create` does. */
const createdPullRequests = ({ tool, input, output }: ShellEntry) =>
  tool === "Bash" && isRecord(input) && typeof input.command === "string"
    ? changeRequestsCreatedBy(input.command, output).map(({ url }) => url)
    : [];
/**
 * One sample's state. ToolSearch adds loaded schemas to `tools`, like Claude Code. `shell` is the
 * history the simulator keeps consistent with; `linked` and `nextTask` do the same for T3 results.
 */
type Sample = {
  readonly testCase: McpToolUseCase;
  readonly base: Base;
  readonly tools: Array<ApiTool>;
  readonly repo: string;
  readonly shell: Array<ShellEntry>;
  readonly shellUsage: Usage;
  readonly linked: Set<string>;
  readonly codeStore: Record<string, unknown>;
  nextTask: number;
  /** T3's device tools, once `withDevices` builds them for a world with devices. */
  devices?: DeviceTools;
  /** T3's results for prior device calls whose case result is "default". */
  readonly priorResults: Map<unknown, string>;
};

const SHELL_TOOLS = new Set(["Bash", "Read", "Edit", "Write", "WebFetch"]);

export const makeSample = (testCase: McpToolUseCase, base: Base): Sample => {
  const prior = testCase.setup.priorTurns ?? [];
  const priorCalls = prior.flatMap((turn) => turn.toolCalls ?? []);
  const repo = testCase.setup.world?.repo ?? "acme/app";
  const urls = [
    ...(testCase.setup.world?.linkedPullRequests ?? []).map(
      ({ number }) => pullRequest(repo, { number }).url,
    ),
    ...priorCalls.flatMap((call) =>
      ["link_pull_request", "watch_pull_request"].includes(call.tool) && isRecord(call.input)
        ? [pullRequest(repo, call.input).url]
        : call.tool === "link_pull_requests" &&
            isRecord(call.input) &&
            Array.isArray(call.input.urls)
          ? call.input.urls
              .filter((url) => PULL_REQUEST_URL.test(valueText(url)))
              .map((url) => pullRequest(repo, { url }).url)
          : [],
    ),
  ];
  const taskNumbers = [...valueText(prior).matchAll(/task-(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const shell = priorCalls
    .filter((call) => SHELL_TOOLS.has(call.tool))
    .map(({ tool, input, result }) => ({ tool, input, output: valueText(result) }));
  return {
    testCase,
    base,
    tools: [...base.nativeTools],
    repo: testCase.setup.world?.repo ?? "acme/app",
    shell,
    shellUsage: emptyUsage(),
    linked: new Set([...urls, ...shell.flatMap(createdPullRequests)]),
    codeStore: {},
    nextTask: Math.max(0, ...taskNumbers) + 1,
    priorResults: new Map(),
  };
};

/**
 * Builds T3's device tools for a world with devices. Prior device calls whose result is "default"
 * run first, in order and without the case's mocks, so their results and sessions are T3's. As in
 * the real flow, device_open starts no agent-device session: one starts at a launcher `open` in the
 * sample's shell history, prior turns included, or where `world.agentDeviceSessions` declares it.
 */
export const withDevices = Effect.fn("evaluateMcpToolUse.withDevices")(function* (sample: Sample) {
  const world = sample.testCase.setup.world;
  if (world?.devices === undefined) return;
  sample.devices = yield* makeDeviceTools(
    { ...world, devices: world.devices },
    sample.base.environment,
  );
  for (const call of (sample.testCase.setup.priorTurns ?? []).flatMap((t) => t.toolCalls ?? [])) {
    if (call.result !== "default" || !isDeviceTool(call.tool)) continue;
    sample.priorResults.set(call, (yield* sample.devices.call(call.tool, call.input)).text);
  }
});

// Main's history under every case's world.
const MAIN_COMMITS = [
  { sha: "9f2c1ab", subject: "feat(web): show the model name in the thread header" },
  { sha: "4e7d2c0", subject: "fix(server): retry provider start once on ENOENT" },
  { sha: "b81f3d9", subject: "chore: update dependencies" },
];

/**
 * The gitStatus Claude Code shows when a session starts, built from the case's world. Commits and
 * a branch that the prior turns made (their tool results show it) came later, so they are left out.
 */
const gitStatus = ({ setup }: McpToolUseCase) => {
  const prior = valueText(setup.priorTurns ?? []);
  const branch = setup.world?.branch ?? "main";
  const commits = [...(setup.world?.commits ?? []), ...MAIN_COMMITS].filter(
    (commit) => !prior.includes(` ${commit.sha}] `),
  );
  return [
    "As you answer the user's questions, you can use the following context:",
    "# gitStatus",
    "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
    "",
    `Current branch: ${prior.includes(`Switched to a new branch '${branch}'`) ? "main" : branch}`,
    "",
    "Main branch (you will usually use this for PRs): main",
    "",
    "Status:",
    setup.world?.status || "(clean)",
    "",
    "Recent commits:",
    ...commits.slice(0, 5).map((commit) => `${commit.sha} ${commit.subject}`),
    "",
    "Claude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
  ].join("\n");
};

const findTool = (base: Base, bare: string) =>
  [...base.nativeTools, ...base.deferred].find((tool) => normalizeToolName(tool.name) === bare) ??
  (base.codex ? { name: bare } : undefined);

/** Adds deferred schemas to `tools` and returns the ToolSearch result Claude Code sends. */
const loadTools = (tools: Array<ApiTool>, id: string, found: ReadonlyArray<ApiTool>): Block => {
  for (const tool of found) {
    if (!hasTool(tools, tool.name)) tools.push({ ...tool, defer_loading: true });
  }
  const content = found.map((tool) => ({ type: "tool_reference", tool_name: tool.name }));
  return { type: "tool_result", tool_use_id: id, content };
};

/** Messages for a case: reminders, context, prior turns with real tool blocks, then the prompt. */
export const buildMessages = (sample: Sample) => {
  const { testCase, base, tools } = sample;
  const messages: Array<ApiMessage> = [];
  const push = (role: ApiMessage["role"], ...blocks: ReadonlyArray<Block>) => {
    const last = messages.at(-1);
    if (last?.role !== role) messages.push({ role, content: blocks });
    else messages[messages.length - 1] = { role, content: [...last.content, ...blocks] };
  };
  const { role, context, delegateRole, priorTurns = [] } = testCase.setup;
  const native = role === "native-subagent";
  const notes = [
    native
      ? "You are a subagent started by the parent agent's Agent tool. Your final message goes to the parent agent, not to the user."
      : undefined,
    context,
  ];
  const reminders = base.reminders.toSpliced(base.gitStatusAt, 0, reminder(gitStatus(testCase)));
  push("user", ...reminders, ...notes.flatMap((note) => (note ? [reminder(note)] : [])));
  const toolSearch = findTool(base, "ToolSearch")?.name ?? "ToolSearch";
  let nextId = 0;
  for (const turn of priorTurns) {
    const calls = (turn.toolCalls ?? []).map((call) => {
      const tool = findTool(base, call.tool);
      if (tool === undefined) throw new Error(`${testCase.id}: unknown prior tool ${call.tool}.`);
      if (call.result === "default" && isDeviceTool(call.tool) && !sample.priorResults.has(call)) {
        throw new Error(`${testCase.id}: prior ${call.tool} needs T3's result; run withDevices.`);
      }
      return { ...call, id: `toolu_prior_${nextId++}`, name: tool.name, tool, prior: call };
    });
    // Prior T3 calls load their schemas first, as in a real deferred session.
    const unloaded = [...new Set(calls.map((call) => call.tool))].filter(
      (tool) => !hasTool(tools, tool.name),
    );
    if (unloaded.length > 0 && !base.codex) {
      const id = `toolu_prior_${nextId++}`;
      const query = `select:${unloaded.map((tool) => tool.name).join(",")}`;
      const input = { query, max_results: unloaded.length };
      push("assistant", { type: "tool_use", id, name: toolSearch, input });
      push("user", loadTools(tools, id, unloaded), text(TOOL_LOADED));
    }
    // One call per step, as most real turns run them.
    for (const { id, name, input, result, tool, prior } of calls) {
      push("assistant", { type: "tool_use", id, name, input });
      const replayed =
        normalizeToolName(tool.name) === "orchestrator_capabilities"
          ? capabilities(sample, result)
          : (sample.priorResults.get(prior) ?? result);
      push("user", toolResult(id, replayed));
    }
    if (turn.text) push(turn.role, text(turn.text));
  }
  const userText =
    testCase.promptContext === undefined
      ? testCase.prompt
      : projectComposerContextForProvider({ text: testCase.prompt, ...testCase.promptContext });
  const sideChat = testCase.setup.sideChat;
  const prompt =
    sideChat === undefined
      ? userText
      : withInlineContext(
          makeSideChatContext({
            parentThreadId: ThreadId.make(sideChat.parentThreadId),
            digest: sideChat.digest,
          }),
          userText,
        );
  const childPrompt = () => taskPrompt({ task: prompt, role: delegateRole });
  push("user", text(role === "delegated-child" ? childPrompt() : prompt));
  // Claude Code gives a subagent its SubagentStart hooks' context as a reminder after the task.
  if (native && base.subagentContext) {
    push("user", reminder(`SubagentStart hook additional context: ${base.subagentContext}`));
  }
  return messages;
};

// Results for T3 tools a case does not mock. The model ids are public in this repo's catalog.
const claudeModel = (id: string) => ({ id, options: [{ id: "effort", values: EFFORTS }] });
const codexModel = (id: string) => ({ id, options: [{ id: "reasoningEffort", values: EFFORTS }] });
// Mirrors the real catalog's main models, so a case's named model is not missing by accident.
const PROVIDERS = [
  {
    providerInstanceId: "claudeAgent",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5"].map(
      claudeModel,
    ),
  },
  {
    providerInstanceId: "codex",
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].map(codexModel),
  },
  { providerInstanceId: "muse", models: ["muse-wonder-full", "muse-wonder"].map(codexModel) },
  { providerInstanceId: "grok", models: ["grok-4.7"].map(codexModel) },
];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEFAULT_THREAD = {
  title: "Fix the flaky reconnect test",
  status: "idle",
  items: [
    {
      position: 1,
      createdBy: "user",
      text: "The reconnect test in src/session.test.ts fails about 1 in 10 runs. Fix it.",
    },
    {
      position: 2,
      createdBy: "assistant",
      text: "Fixed. The test now waits for the socket close event before it reconnects. 20 runs in a row pass.",
    },
  ],
};
const HTML_RENDERED =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

const PULL_REQUEST_URL = /\/pull\/\d+\/?$/;

/** Pull request identity from a `url` or `repository` plus `number` input, like T3's results. */
const pullRequest = (repo: string, input: Readonly<Record<string, unknown>>) => {
  const url = typeof input.url === "string" ? input.url : "";
  const repository =
    /github\.com\/([^/]+\/[^/]+)\/pull/.exec(url)?.[1] ?? valueText(input.repository ?? repo);
  const number = Number(/(\d+)\/?$/.exec(url)?.[1] ?? input.number);
  return {
    host: "github.com",
    repository,
    number,
    url: url || `https://github.com/${repository}/pull/${number}`,
  };
};

/** A linked PR as `list_thread_pull_requests` shows it. Links made in the sample are open. */
const linkedEntry = (sample: Sample, url: string) => {
  const pr = pullRequest(sample.repo, { url });
  const seeded = sample.testCase.setup.world?.linkedPullRequests?.find(
    ({ number }) => number === pr.number && pr.repository === sample.repo,
  );
  return { ...pr, state: seeded?.state ?? "open", title: seeded?.title ?? null };
};

/** A believable T3 result for a tool the case does not mock. */
const t3Default = (sample: Sample, name: string, input: Readonly<Record<string, unknown>>) => {
  const pr = () => pullRequest(sample.repo, input);
  switch (name) {
    case "orchestrator_capabilities":
      return {
        inheritedProviderInstanceId: "claudeAgent",
        inheritedModel: sample.base.model,
        providers: PROVIDERS,
      };
    case "delegate_task": {
      const n = sample.nextTask++;
      const target = isRecord(input.target) ? input.target : {};
      return {
        taskId: `task-${n}`,
        childThreadId: uuid(n),
        childRunId: `run-${n}`,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        providerInstanceId:
          target.providerInstanceId ?? (sample.base.codex ? "codex" : "claudeAgent"),
        model: target.model ?? sample.base.model,
        summary: null,
        hasPendingQuestion: false,
        pendingApproval: null,
      };
    }
    case "task_status":
      return {
        taskId: input.taskId,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        summary: null,
      };
    case "task_cancel":
      return { taskId: input.taskId, status: "cancel_requested" };
    case "link_pull_request": {
      const alreadyLinked = sample.linked.has(pr().url);
      sample.linked.add(pr().url);
      return { ...pr(), alreadyLinked };
    }
    case "link_pull_requests": {
      const urls = Array.isArray(input.urls) ? input.urls.map(valueText) : [];
      const invalidUrls = urls.filter((url) => !PULL_REQUEST_URL.test(url));
      const targets = [...new Set(urls.filter((url) => PULL_REQUEST_URL.test(url)))].map((url) =>
        pullRequest(sample.repo, { url }),
      );
      const fresh = targets.filter(({ url }) => !sample.linked.has(url));
      for (const { url } of targets) sample.linked.add(url);
      const byRepository = (prs: ReadonlyArray<ReturnType<typeof pullRequest>>) =>
        [...Map.groupBy(prs, (pr) => pr.repository).values()].map((group) => ({
          host: "github.com",
          repository: group[0]!.repository,
          numbers: group.map((pr) => pr.number),
        }));
      return {
        linked: byRepository(fresh),
        alreadyLinked: byRepository(targets.filter((pr) => !fresh.includes(pr))),
        linkedCount: targets.length,
        ...(invalidUrls.length > 0 ? { invalidUrls } : {}),
      };
    }
    case "request_secret": {
      // T3 names both a ref and a file with 32 hex characters, and keeps files in its secrets dir.
      const id = "5f0c9e2a7b4d4183a6e1c8d2b9f07a64";
      const home =
        /^\/(?:home|Users)\/[^/]+/.exec(sample.base.environment.cwd)?.[0] ?? "/home/user";
      return input.delivery === "file"
        ? { status: "saved", file: `${home}/.t3/userdata/secrets/files/${id}` }
        : { status: "saved", secretRef: `secret-ref:${id}` };
    }
    case "unlink_pull_request":
      return { ...pr(), wasLinked: sample.linked.delete(pr().url) };
    case "unlink_pull_requests": {
      const states = Array.isArray(input.states) ? input.states : [];
      const unlinked = [...sample.linked]
        .map((url) => linkedEntry(sample, url))
        .filter((entry) => states.includes(entry.state));
      for (const { url } of unlinked) sample.linked.delete(url);
      const groups = Map.groupBy(unlinked, (entry) => `${entry.repository}/${entry.state}`);
      return {
        unlinked: [...groups.values()].map((entries) => ({
          host: "github.com",
          repository: entries[0]!.repository,
          state: entries[0]!.state,
          numbers: entries.map((entry) => entry.number),
        })),
        unlinkedCount: unlinked.length,
        remaining: sample.linked.size,
      };
    }
    case "watch_pull_request":
      sample.linked.add(pr().url);
      return { ...pr(), watching: true, wasWatching: false };
    case "unwatch_pull_request":
      return { ...pr(), watching: false, wasWatching: true };
    case "list_thread_pull_requests":
      return {
        pullRequests: [...sample.linked].map((url) => ({
          ...linkedEntry(sample, url),
          source: "agent",
          watching: false,
        })),
        chains: [],
      };
    case "t3_thread_read": {
      const threadId = valueText(input.threadId);
      const { title, status, items } = DEFAULT_THREAD;
      return { thread: { threadId, title, status }, items, nextPosition: 3, hasMore: false };
    }
    case "html_preview":
      return { width: 728, contentHeight: 560, capturedHeight: 560, consoleMessages: [] };
    case "html_render":
      return {
        htmlRender: { attachmentId: "att-1", title: input.title ?? "Visual", height: 560 },
        message: HTML_RENDERED,
      };
    case "preview_status":
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      };
    default:
      return { ok: true };
  }
};

/** The machine the fake threads live on. */
const EVAL_ENVIRONMENT_ID = EnvironmentId.make("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

/** Fields T3 adds to real thread and task results, applied to mocks and defaults alike. */
const withProductFields = (name: string, value: unknown, child: boolean): unknown => {
  if (!isRecord(value)) return value;
  const linked = (thread: unknown, idKey = "threadId") => {
    if (!isRecord(thread) || thread.link !== undefined) return thread;
    const id = thread[idKey] ?? thread.id;
    return typeof id === "string"
      ? {
          ...thread,
          link: formatThreadLink({
            environmentId: EVAL_ENVIRONMENT_ID,
            threadId: ThreadId.make(id),
          }),
        }
      : thread;
  };
  const listed = (key: string) =>
    Array.isArray(value[key]) ? { ...value, [key]: value[key].map((item) => linked(item)) } : value;
  switch (name) {
    case "delegate_task":
    case "task_status": {
      const task = linked(value, "childThreadId") as Record<string, unknown>;
      const running = task.status === "running" && task.next === undefined;
      return running ? { ...task, next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } : task;
    }
    case "t3_thread_read":
      return { ...value, thread: linked(value.thread) };
    case "t3_thread_launch":
    case "t3_thread_send":
    case "run_scheduled_task_now":
      return linked(value);
    case "t3_thread_list":
    case "create_threads":
      return listed("threads");
    case "t3_thread_search":
      return listed("matches");
    case "link_pull_request":
    case "link_pull_requests":
      return child ? { ...value, next: CHILD_PULL_REQUEST_REPORT_NEXT } : value;
    default:
      return value;
  }
};

/** Cases mock a Claude caller, so the inherited fields follow the model under test. */
const capabilities = ({ base }: Sample, value: unknown) =>
  isRecord(value)
    ? {
        ...value,
        inheritedModel: base.model,
        ...(base.codex
          ? {
              inheritedProviderInstanceId: "codex",
              inheritedOptions: [{ id: "reasoningEffort", value: base.codex.reasoning.effort }],
            }
          : {}),
      }
    : value;

/** ToolSearch: `select:a,b` loads those tools. Other queries load tools whose name has a word. */
const searchTools = (base: Base, query: string, max: number) => {
  if (query.startsWith("select:")) {
    const wanted = query.slice("select:".length).split(",");
    return base.deferred.filter((tool) =>
      wanted.some((name) => [tool.name, normalizeToolName(tool.name)].includes(name.trim())),
    );
  }
  const words = query
    .toLowerCase()
    .split(/[\s+]+/)
    .filter(Boolean);
  const hits = (tool: ApiTool) => words.filter((word) => tool.name.toLowerCase().includes(word));
  const found = base.deferred.filter((tool) => hits(tool).length > 0);
  return found.toSorted((a, b) => hits(b).length - hits(a).length).slice(0, max);
};

const SUBAGENT_WATCH_ERROR =
  "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";

/** Result for a native tool the case does not mock, other than shell, file, and web tools. */
const nativeResult = (name: string, input: Readonly<Record<string, unknown>>) => {
  const skill = valueText(input.skill);
  const results: Readonly<Record<string, string>> = {
    Agent: "The agent finished. Summary: the task is done and nothing else needs attention.",
    Skill: `Launching skill: ${skill}\n\nBase directory for this skill: ~/.claude/skills/${skill}\n\nThis skill adds no steps for this task. Do it with your usual tools.`,
    WebSearch: "No results found.",
  };
  return results[name] ?? "OK";
};

const SHELL_PROMPT = `You play the computer a coding agent works on. You get a description of the machine, the agent's tool calls so far with their outputs, and one new call. Reply in JSON. In "facts", note briefly what the output must agree with. In "output", put only the call's output, exactly as the tool prints it: no notes, headings, code fences, or corrections. The agent sees "output" unchanged.

- Bash: what the command prints in a real terminal (git, gh, ls, cat, grep, package managers). If it fails, start with "Exit code N", then the error. If it prints nothing, reply "(Bash completed with no output)".
- Read: the file with numbered lines, like \`cat -n\`. Write: "File created successfully at: <path>". Edit: "The file <path> has been updated successfully." Edit may instead supply a Codex apply_patch patch; apply its additions, deletions and hunks. A missing file, or an Edit whose old_string is not in the file: "<tool_use_error>reason</tool_use_error>".
- WebFetch: the page's text.

Stay consistent with the machine and with earlier outputs: edits, commits, pushes, and new PRs show in later output. Where the description is silent, invent plausible small details that fit it (file contents, SHAs, test names) rather than printing nothing. Commands succeed unless the description says otherwise, including git push, gh pr create, installs, builds, and tests. A new PR gets the next number after the highest one in the description or the history, or 124 if there is none.`;

const ShellReply = Schema.Struct({ facts: Schema.String, output: Schema.String });
const SHELL_REPLY_SCHEMA = {
  ...Schema.toJsonSchemaDocument(ShellReply).schema,
  additionalProperties: false,
};
const decodeShellReply = Schema.decodeUnknownOption(Schema.fromJsonString(ShellReply));

const callText = ({ tool, input }: Omit<ShellEntry, "output">) =>
  `<call>${tool} ${valueText(input)}</call>`;

/** The simulator's request: the machine, this sample's earlier calls, then the new call. */
export const shellRequest = (sample: Sample, call: Omit<ShellEntry, "output">, model: string) => {
  const { testCase, base, repo, shell, devices } = sample;
  const { world, context, shellMocks = [] } = testCase.setup;
  const { cwd, platform, date } = base.environment;
  const command = call.tool === "Bash" && isRecord(call.input) ? call.input.command : undefined;
  const machine = [
    `Working directory: ${cwd} on ${platform}, a git checkout of github.com/${repo}.${date ? ` Today is ${date}.` : ""}`,
    gitStatus(testCase),
    `World: ${valueText(world ?? {})}`,
    ...(shellMocks.length > 0
      ? [`Commands that match these regexes print exactly this output: ${valueText(shellMocks)}`]
      : []),
    // Which device each launcher and session drives, and which of this call's opens are refused.
    ...(devices?.describe(shell, typeof command === "string" ? command : undefined) ?? []),
    ...(world?.deviceInvalidCapture
      ? [
          "T3's device_screenshot gets each capture with adb screencap's multi-display warning ahead of the PNG, so it reports 0×0. agent-device's own screenshot finds the PNG and is unaffected.",
        ]
      : []),
    ...(context ? [`The agent was told: ${context}`] : []),
    `The agent's task: ${testCase.prompt}`,
  ];
  const history = shell.map((entry) => `${callText(entry)}\n<output>\n${entry.output}\n</output>`);
  return {
    model,
    max_tokens: 8_000,
    // The "facts" field keeps the simulator's reasoning out of the output the agent sees.
    output_config: { effort: "low", format: { type: "json_schema", schema: SHELL_REPLY_SCHEMA } },
    // A case with devices also gets agent-device's own CLI, so T3's launchers answer as it does.
    system: devices ? `${SHELL_PROMPT}\n\n${AGENT_DEVICE_SHELL}` : SHELL_PROMPT,
    messages: [
      {
        role: "user",
        content: [machine, [...history, `New call:\n${callText(call)}`]].map((part) =>
          text(part.join("\n\n")),
        ),
      },
    ],
  };
};

/** The tool output in the simulator's JSON reply, or its raw text if that is not JSON. */
export const shellOutput = (content: ReadonlyArray<Block>) => {
  const reply = content.flatMap((block) => (isText(block) ? [block.text] : [])).join("");
  return Option.match(decodeShellReply(reply), {
    onNone: () => reply.trim(),
    onSome: ({ output }) => output.trim(),
  });
};

/** A shell mock's output, when the command is one simple command that the mock matches. */
export const mockOutput = (sample: Sample, command: string) =>
  /&&|\|\||[;|\n]/.test(command.trim())
    ? undefined
    : sample.testCase.setup.shellMocks?.find((mock) => new RegExp(mock.match).test(command))
        ?.output;

type Config = {
  readonly apiKey: string;
  readonly model: Model;
  readonly proxy?: { readonly url: string; readonly headers: Readonly<Record<string, string>> };
  readonly effort: string;
  readonly maxSteps: number;
  readonly shellModel: PricedModel;
};

/**
 * Output for a command that needs no simulator: a matching shell mock, else, for a plain command
 * on a launcher T3 returned, agent-device's help or its error for a session not yet started.
 */
export const cannedOutput = (sample: Sample, command: string) =>
  mockOutput(sample, command) ??
  launcherHelp(sample.devices?.launchers ?? [], command) ??
  sample.devices?.sessionError(sample.shell, command);

/** Output for a shell, file, or web tool: canned output, else the shell simulator. */
const simulate = Effect.fn("evaluateMcpToolUse.simulate")(function* (
  sample: Sample,
  config: Config,
  call: Omit<ShellEntry, "output">,
) {
  const command = call.tool === "Bash" && isRecord(call.input) ? call.input.command : undefined;
  let output = typeof command === "string" ? cannedOutput(sample, command) : undefined;
  if (output === undefined) {
    const body = shellRequest(sample, call, config.shellModel);
    const response = yield* callModel(
      config.apiKey,
      body,
      config.apiKey ? undefined : config.proxy,
    );
    addUsage(sample.shellUsage, response.usage);
    output = shellOutput(response.content);
  }
  if (call.tool === "Bash" && output === "") output = "(Bash completed with no output)";
  const entry = { ...call, output };
  sample.shell.push(entry);
  for (const url of createdPullRequests(entry)) sample.linked.add(url);
  return output;
});

/** The result for one tool call. */
const answerToolCall = Effect.fn("evaluateMcpToolUse.answerToolCall")(function* (
  sample: Sample,
  config: Config,
  call: typeof ToolUse.Type,
) {
  const { testCase, base, tools } = sample;
  let name = normalizeToolName(call.name);
  let input = isRecord(call.input) ? call.input : {};
  if (call.name === "web__run") {
    const open = Array.isArray(input.open) ? input.open[0] : undefined;
    const search = Array.isArray(input.search_query) ? input.search_query[0] : undefined;
    name = open ? "WebFetch" : "WebSearch";
    input = isRecord(open)
      ? { url: open.ref_id, prompt: "Return the page content." }
      : isRecord(search)
        ? { query: search.q }
        : input;
  }
  const failed = (error: string): Block => ({ ...toolResult(call.id, error), is_error: true });
  if (!base.codex && !hasTool(tools, call.name)) {
    const error = `InputValidationError: ${call.name} is deferred. Load it with ToolSearch first.`;
    return failed(`<tool_use_error>${error}</tool_use_error>`);
  }
  if (name === "ToolSearch") {
    const max = typeof input.max_results === "number" ? input.max_results : 5;
    const found = searchTools(base, valueText(input.query), max);
    if (found.length === 0) return toolResult(call.id, "No matching deferred tools found");
    return loadTools(tools, call.id, found);
  }
  const mock = testCase.setup.mocks?.[name];
  // T3 answers device calls from the world. A mock that is a T3 device error fails inside T3.
  const failure = deviceFailure(mock);
  const fromWorld = mock === undefined || mock === "default" || failure !== undefined;
  if (sample.devices && isT3Name(call.name) && isDeviceTool(name) && fromWorld) {
    const result = yield* sample.devices.call(name, input, failure);
    return result.isError ? failed(result.text) : toolResult(call.id, result.text);
  }
  if (mock !== undefined && mock !== "default")
    return toolResult(
      call.id,
      name === "orchestrator_capabilities"
        ? capabilities(sample, mock)
        : withProductFields(name, mock, testCase.setup.role === "delegated-child"),
    );
  if (isT3Name(call.name)) {
    // T3 refuses a watch from a delegated child.
    if (name === "watch_pull_request" && testCase.setup.role === "delegated-child") {
      return failed(SUBAGENT_WATCH_ERROR);
    }
    const value = t3Default(sample, name, input);
    return toolResult(
      call.id,
      name === "orchestrator_capabilities"
        ? capabilities(sample, value)
        : withProductFields(name, value, testCase.setup.role === "delegated-child"),
    );
  }
  if (call.name === "clock__curr_time")
    return toolResult(call.id, {
      current_time: `${base.environment.date ?? "2026-01-01"} 12:00:00 UTC`,
    });
  if (!SHELL_TOOLS.has(name)) return toolResult(call.id, nativeResult(name, input));
  const output = yield* simulate(sample, config, { tool: name, input });
  // Claude Code marks a failed command or file call as an error.
  return /^(Exit code [1-9]|<tool_use_error>)/.test(output)
    ? failed(output)
    : toolResult(call.id, output);
});

const BOUND = /^([<>]=)(-?\d+(?:\.\d+)?)$/;
/** Partial match: `~text` is a case-insensitive substring, `<=N` / `>=N` bound a number. */
const matches = (expected: unknown, actual: unknown): boolean => {
  const bound = typeof expected === "string" ? BOUND.exec(expected) : null;
  if (bound !== null) {
    const limit = Number(bound[2]);
    return typeof actual === "number" && (bound[1] === "<=" ? actual <= limit : actual >= limit);
  }
  if (typeof expected === "string" && expected.startsWith("~")) {
    return valueText(actual).toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && expected.every((item) => actual.some((at) => matches(item, at)))
    );
  }
  if (!isRecord(expected)) return expected === actual;
  const at = (path: string) =>
    path
      .split(".")
      .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), actual);
  return Object.entries(expected).every(([path, value]) => matches(value, at(path)));
};

/** delegate_task takes `target.options` as an object or `[{id, value}]`. Grade both as an object. */
const withOptionsObject = (input: unknown) => {
  if (!isRecord(input) || !isRecord(input.target) || !Array.isArray(input.target.options)) {
    return input;
  }
  const options = Object.fromEntries(
    input.target.options.flatMap((option) =>
      isRecord(option) ? [[valueText(option.id), option.value]] : [],
    ),
  );
  return { ...input, target: { ...input.target, options } };
};

export const gradeSample = (expect: McpToolUseCase["expect"], run: SampleRun) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const calls = run.calls.map((call) => ({ ...call, input: withOptionsObject(call.input) }));
  const count = (tool: string) => calls.filter((call) => call.tool === tool).length;
  // `tool` may list alternatives, as in "link_pull_request|watch_pull_request".
  const found = ({ tool, args = {} }: McpToolUseCall) =>
    calls.some((call) => tool.split("|").includes(call.tool) && matches(args, call.input));
  const label = ({ tool, args }: McpToolUseCall) => (args ? `${tool} ${valueText(args)}` : tool);
  for (const call of expect.calls ?? []) add(`calls ${label(call)}`, found(call));
  for (const call of expect.callsMustNot ?? []) add(`callsMustNot ${label(call)}`, !found(call));
  for (const tool of expect.notCalls ?? []) add(`notCalls ${tool}`, count(tool) === 0);
  if (expect.order !== undefined) {
    const firsts = expect.order.map((tool) => calls.findIndex((call) => call.tool === tool));
    const inOrder = firsts.every((at, i) => at > (firsts[i - 1] ?? -1));
    add(`order ${expect.order.join(" > ")}`, inOrder);
  }
  for (const [t, n] of Object.entries(expect.minCalls ?? {}))
    add(`minCalls ${t} >= ${n}`, count(t) >= n);
  for (const [t, n] of Object.entries(expect.maxCalls ?? {}))
    add(`maxCalls ${t} <= ${n}`, count(t) <= n);
  if (expect.endsTurnAfter !== undefined) {
    const lastStep = Math.max(-1, ...calls.map((call) => call.step));
    const last = calls.filter((call) => call.step === lastStep).map((call) => call.tool);
    const ended = run.stopReason === "end_turn" && last.includes(expect.endsTurnAfter);
    add(`endsTurnAfter ${expect.endsTurnAfter}`, ended);
  }
  // Bash and Monitor both take a shell `command`.
  const shell = calls.flatMap((call) =>
    isRecord(call.input) && typeof call.input.command === "string" ? [call.input.command] : [],
  );
  const test = (pattern: string, value: string) => new RegExp(pattern).test(value);
  for (const p of expect.shellMustNot ?? [])
    add(`shellMustNot /${p}/`, !shell.some((c) => test(p, c)));
  for (const p of expect.textMust ?? []) add(`textMust /${p}/`, test(p, run.text));
  for (const p of expect.textMustNot ?? []) add(`textMustNot /${p}/`, !test(p, run.text));
  const isLinked = (url: string) => (run.linked ?? []).some((at) => matches(url, at));
  for (const url of expect.linked ?? []) add(`linked ${url}`, isLinked(url));
  if (expect.linkedNumbers !== undefined) {
    const numbers = (run.linked ?? []).map((url) => Number(/(\d+)\/?$/.exec(url)?.[1]));
    const exact = valueText(numbers.toSorted((a, b) => a - b));
    add("linkedNumbers", exact === valueText(expect.linkedNumbers.toSorted((a, b) => a - b)));
  }
  checks.push(...gradeDevice(expect.device, run));
  return checks;
};

// Checks that can only go from pass to fail as a sample goes on.
const SETTLED = /^(notCalls|callsMustNot|shellMustNot|maxCalls|textMustNot) /;
/** True once the sample has failed for good, so the rest of it cannot change the result. */
export const failedEarly = (expect: McpToolUseCase["expect"], run: SampleRun) =>
  gradeSample(expect, run).some((check) => !check.pass && SETTLED.test(check.check));

const requestBody = ({ base, tools }: Sample, effort: string, messages: unknown) => ({
  model: base.model,
  max_tokens: 16_000,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort },
  cache_control: { type: "ephemeral" },
  // Like Claude Code, cache the shared system prompt so every sample reuses it.
  system: base.system.map((block, i) =>
    i === base.system.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block,
  ),
  tools,
  messages,
});

const codexRequest = (base: Base, input: ReadonlyArray<Block>) => ({
  model: base.model,
  stream: true,
  store: false,
  parallel_tool_calls: true,
  reasoning: base.codex?.reasoning,
  instructions: base.codex?.instructions,
  text: base.codex?.text,
  tool_choice: base.codex?.tool_choice,
  include: ["reasoning.encrypted_content"],
  input: [...(base.codex?.input ?? []), ...input],
});

/** The bridge only accepts serialized data. Model code never receives host objects/functions. */
export const executeCodex = async (
  code: string,
  catalog: ReadonlyArray<{ name: string; description: string }>,
  answer: (name: string, input: unknown) => Promise<unknown>,
  saved: Record<string, unknown> = {},
) => {
  const pending: Array<{ name: string; input: string; resolve: (value: string) => void }> = [];
  const bridge = Object.setPrototypeOf(
    (name: string, input: string, resolve: (value: string) => void) =>
      pending.push({ name, input, resolve }),
    null,
  );
  const context = NodeVM.createContext(
    { __bridge: bridge, __catalog: JSON.stringify(catalog), __storeJson: JSON.stringify(saved) },
    { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" },
  );
  const run = (source: string) => NodeVM.runInContext(source, context, { timeout: 250 });
  run(`((bridge, catalog) => {
    delete globalThis.__bridge; delete globalThis.__catalog;
    globalThis.ALL_TOOLS = catalog;
    globalThis.tools = Object.fromEntries(catalog.map(({name}) => [name, (input) => new Promise(resolve => bridge(name, JSON.stringify(input ?? {}), value => resolve(JSON.parse(value))))]));
    globalThis.__output = []; globalThis.__done = false;
    globalThis.text = globalThis.notify = value => __output.push(typeof value === 'string' ? value : JSON.stringify(value));
    globalThis.__stored = JSON.parse(__storeJson); delete globalThis.__storeJson;
    globalThis.store = (k,v) => __stored[k] = v; globalThis.load = k => __stored[k];
  })(__bridge, JSON.parse(__catalog));
  (async () => { ${code}\n })().then(() => { __done = true; }, e => { text(String(e)); __done = true; });`);
  // Unawaited calls still run, as they do in Codex, so they are answered and graded too.
  for (let count = 0; !context.__done || pending.length > 0; count++) {
    if (count === 128) throw new Error("Code cell exceeded 128 tool calls.");
    const job = pending.shift();
    if (!job) throw new Error("Code cell stalled without a tool call.");
    const result = await answer(job.name, JSON.parse(job.input));
    context.__resolve = job.resolve;
    context.__result = JSON.stringify(result ?? null);
    run("__resolve(__result); delete globalThis.__resolve; delete globalThis.__result;");
  }
  Object.assign(saved, JSON.parse(run("JSON.stringify(__stored)")));
  return valueText(context.__output.join("\n"));
};

const codexCatalog = (base: Base) => [
  ...base.t3.map((tool) => ({
    name: tool.name.replace("mcp__t3-code__", "mcp__t3_code__"),
    description: `${valueText(tool.description)}\nInput JSON schema: ${JSON.stringify(tool.input_schema)}`,
  })),
  ...[
    ...valueText(base.nativeTools.find((tool) => tool.name === "exec")?.description).matchAll(
      /### `([^`]+)`/g,
    ),
  ].map((match) => ({ name: match[1]!, description: match[1]! })),
];

const CodexResponse = Schema.Struct({
  output: Schema.Array(AnyBlock),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    input_tokens_details: Schema.Struct({ cached_tokens: Schema.Number }),
  }),
});

const decodeCodexResponse = Schema.decodeUnknownEffect(CodexResponse);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const callCodex = Effect.fn("evaluateMcpToolUse.callCodex")(function* (
  config: Config,
  body: unknown,
) {
  const raw = yield* postModel("", body, config.proxy, true);
  const completed = raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .find((event) => event.type === "response.completed");
  if (!completed)
    return yield* Effect.die(new Error("Responses stream ended without response.completed."));
  const response = yield* decodeCodexResponse(completed.response);
  return {
    raw: response.output,
    content: response.output.flatMap((item): Array<Block> => {
      if (item.type === "message" && Array.isArray(item.content))
        return item.content.map((part: Block) => text(valueText(part.text)));
      if (item.type === "function_call" || item.type === "custom_tool_call")
        return [
          {
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input:
              item.type === "custom_tool_call" ? item.input : JSON.parse(valueText(item.arguments)),
          },
        ];
      return [];
    }),
    stop_reason: response.output.some(
      (item) => item.type.endsWith("tool_call") || item.type === "function_call",
    )
      ? "tool_use"
      : "end_turn",
    usage: {
      ...response.usage,
      input_tokens: response.usage.input_tokens - response.usage.input_tokens_details.cached_tokens,
      cache_read_input_tokens: response.usage.input_tokens_details.cached_tokens,
    },
  };
});

// Concurrent runs share an organization's rate limits. Backing off for up to about 4 minutes
// lets a sample wait out a busy spell, with jitter so samples do not retry in step.
const RETRY = Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("1 minute")]).pipe(
  Schedule.jittered,
);

const postModel = Effect.fn("evaluateMcpToolUse.postModel")(function* (
  apiKey: string,
  body: unknown,
  proxy?: Config["proxy"],
  responses = false,
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    // Anthropic answers 529 when it is overloaded; retryTransient already retries 429 and 5xx.
    HttpClient.filterStatus((status) => status !== 529),
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      while: (error) =>
        error.reason._tag === "StatusCodeError" && error.reason.response.status === 529,
      schedule: RETRY,
      times: 8,
    }),
  );
  const response = yield* HttpClientRequest.post(
    `${proxy?.url ?? "https://api.anthropic.com/v1"}/${responses ? "responses" : "messages"}`,
  ).pipe(
    HttpClientRequest.setHeaders({
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
      // Claude Code sends this beta for `defer_loading` tools and `tool_reference` results.
      "anthropic-beta": "advanced-tool-use-2025-11-20",
      ...proxy?.headers,
    }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  if (response.status !== 200) {
    const body = yield* response.text;
    return yield* Effect.die(new Error(`Model API ${response.status}: ${body}`));
  }
  return yield* response.text;
});
const callModel = (apiKey: string, body: unknown, proxy?: Config["proxy"]) =>
  postModel(apiKey, body, proxy).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ApiResponse))),
  );

/** A tool call as graded. Claude Code runs an `Agent` in the background unless told otherwise. */
const recordedCall = (step: number, use: typeof ToolUse.Type): Call => {
  const tool = normalizeToolName(use.name);
  const input = normalizeToolInput(use.name, use.input);
  const claudeAgent = tool === "Agent" && !use.name.endsWith("spawn_agent") && isRecord(input);
  return {
    step,
    tool,
    input: claudeAgent ? { run_in_background: true, ...input } : input,
    id: use.id,
  };
};

/** Records on a call what the agent saw, so graders can count failed attempts. */
const settle = (call: Call | undefined, result: Block) => {
  if (call !== undefined) {
    call.failed = result.is_error === true;
    call.output = valueText(result.content);
  }
  return result;
};

/** Calls that ran. Claude Code rejects a deferred tool that was not loaded, so it never runs. */
export const ranCalls = (
  { base, tools }: Sample,
  step: number,
  uses: ReadonlyArray<typeof ToolUse.Type>,
) =>
  uses
    .filter((use) => base.codex !== undefined || hasTool(tools, use.name))
    .map((use) => recordedCall(step, use));

/**
 * Runs one sample until the model ends its turn, uses up its steps, or fails a check that no
 * later step can undo. Tokens add up in `spent`, so a sample that errors still reports them.
 */
const runSample = Effect.fn("evaluateMcpToolUse.runSample")(function* (
  testCase: McpToolUseCase,
  config: Config,
  base: Base,
  spent: { readonly usage: Usage; readonly shellUsage: Usage },
) {
  const sample = { ...makeSample(testCase, base), shellUsage: spent.shellUsage };
  yield* withDevices(sample);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<HttpClient.HttpClient>());
  const messages = buildMessages(sample);
  const input = base.codex ? codexMessages(messages) : undefined;
  const transcript: Array<unknown> = [];
  const start = messages.length;
  const calls: Array<Call> = [];
  const said: Array<string> = [];
  const { usage } = spent;
  let stopReason = "max_steps";
  let finalText = "";
  // Codex's code-mode cells take more model calls, so a case's own budget grows for it too.
  const extra = isCodex(config.model) ? 4 : 0;
  const maxSteps = testCase.maxSteps === undefined ? config.maxSteps : testCase.maxSteps + extra;
  for (let step = 0; step < maxSteps; step++) {
    const response = input
      ? yield* callCodex(config, codexRequest(base, input))
      : yield* callModel(config.apiKey, requestBody(sample, config.effort, messages));
    addUsage(usage, response.usage);
    if ("raw" in response) {
      input?.push(...response.raw);
      transcript.push(...response.raw);
    }
    messages.push({ role: "assistant", content: response.content });
    const texts = response.content.filter(isText).map((block) => block.text);
    said.push(...texts);
    const uses = response.content.filter(isToolUse);
    calls.push(...ranCalls(sample, step, uses));
    if (response.stop_reason !== "tool_use") {
      stopReason = response.stop_reason ?? "unknown";
      finalText = texts.join("\n\n");
      break;
    }
    if (failedEarly(testCase.expect, { calls, text: said.join("\n\n"), stopReason })) {
      stopReason = "failed_early";
      break;
    }
    const results = yield* Effect.forEach(uses, (use) =>
      Effect.gen(function* () {
        const own = calls.find((call) => call.id === use.id);
        if (!input) {
          return settle(own, yield* answerToolCall(sample, config, use));
        }
        const answer = (name: string, args: unknown, record = true) => {
          const tool = normalizeToolName(name);
          const normalized = normalizeToolInput(name, args);
          // A code cell's calls are recorded here; a direct function call already was.
          let recorded = own;
          if (record) {
            recorded = { step, tool, input: normalized };
            calls.push(recorded);
          }
          const call = { ...use, name, input: normalized };
          return answerToolCall(sample, config, call).pipe(
            Effect.map((result) => settle(recorded, result)),
            Effect.map((result) => {
              const output = valueText(result.content);
              if (isT3Name(name))
                return {
                  content: [text(output)],
                  ...(!result.is_error
                    ? { structuredContent: Option.getOrElse(decodeJson(output), () => output) }
                    : { isError: true }),
                };
              return tool === "Bash"
                ? {
                    output,
                    exit_code: /^Exit code [1-9]/.test(output) ? 1 : 0,
                    wall_time_seconds: 0,
                  }
                : output;
            }),
            runPromise,
          );
        };
        return yield* Effect.tryPromise(async () => {
          const output =
            use.name === "exec"
              ? await executeCodex(
                  valueText(use.input),
                  codexCatalog(base),
                  answer,
                  sample.codeStore,
                )
              : await answer(use.name, use.input, false);
          const item = {
            type: use.name === "exec" ? "custom_tool_call_output" : "function_call_output",
            call_id: use.id,
            output: valueText(output),
          };
          input.push(item);
          transcript.push(item);
          return toolResult(use.id, output);
        });
      }),
    );
    // Claude Code adds this text after a ToolSearch that loaded tools.
    const loaded = results.some((result) => Array.isArray(result.content));
    messages.push({ role: "user", content: [...results, ...(loaded ? [text(TOOL_LOADED)] : [])] });
    if (failedEarly(testCase.expect, { calls, text: said.join("\n\n"), stopReason })) {
      stopReason = "failed_early";
      break;
    }
  }
  // The transcript (model turns and tool results) shows what the agent saw when a case fails.
  return {
    calls,
    text: said.join("\n\n"),
    stopReason,
    finalText,
    linked: [...sample.linked],
    ...(sample.devices ? { launchers: [...sample.devices.launchers] } : {}),
    usage,
    shellUsage: sample.shellUsage,
    transcript: input ? transcript : messages.slice(start),
  };
}, Effect.scoped);

type ResultRow = Pick<McpToolUseCase, "id" | "kind" | "pattern"> & {
  readonly role: string;
  readonly pass: boolean;
  /** Set when the sample could not run to the end, even after retries. It is not graded. */
  readonly error?: string;
  readonly usage: Usage;
  readonly shellUsage: Usage;
};

/** The share of samples that passed. Samples that errored are left out: NaN if all did. */
const passRate = (
  rows: ReadonlyArray<{ readonly pass: boolean; readonly error?: string | undefined }>,
) => {
  const finished = rows.filter((row) => row.error === undefined);
  return finished.filter((row) => row.pass).length / finished.length;
};
const percent = (rate: number) => (Number.isNaN(rate) ? "-" : `${Math.round(rate * 100)}%`);
const groups = <A>(rows: ReadonlyArray<A>, key: (row: A) => string) =>
  [...Map.groupBy(rows, key)].toSorted(([left], [right]) => left.localeCompare(right));

const USAGE_KEYS = ["input", "output", "cacheWrite", "cacheRead"] as const;
/** Token totals and their cost in USD at one model's prices. Proxy runs have no price. */
const spend = (usages: ReadonlyArray<Usage>, model: PricedModel | undefined) => {
  const total = (key: keyof Usage) => usages.reduce((sum, usage) => sum + usage[key], 0);
  const price = (key: keyof Usage) => (model ? PRICES[model][key] : 0);
  const cost = USAGE_KEYS.reduce((sum, key) => sum + total(key) * price(key), 0) / 1e6;
  return { cost, tokens: USAGE_KEYS.map((key) => `${key} ${total(key)}`).join(", ") };
};

/** Markdown report. With a baseline, each case shows its earlier pass rate and the change. */
export const summarize = (
  rows: Array<ResultRow>,
  options: { readonly header: string; readonly shellModel: PricedModel; readonly model: Model },
  before?: Map<string, number>,
) => {
  const codex = isCodex(options.model);
  const agent = spend(
    rows.map((row) => row.usage),
    codex ? undefined : options.model,
  );
  const shell = spend(
    rows.map((row) => row.shellUsage),
    options.shellModel,
  );
  const cost = agent.cost + shell.cost;
  const table = (title: string, key: (row: ResultRow) => string, compare = false) => [
    `## ${title}\n`,
    compare ? "| Group | Pass | Baseline | Delta |" : "| Group | Pass |",
    compare ? "| --- | --- | --- | --- |" : "| --- | --- |",
    ...groups(rows, key).map(([group, members]) => {
      const now = passRate(members);
      const was = before?.get(group);
      const errored = members.filter((row) => row.error !== undefined).length;
      const delta =
        was === undefined
          ? "new | |"
          : `${percent(was)} | ${Number.isNaN(now) ? "" : `${Math.round((now - was) * 100)} pts`} |`;
      const pass = `${percent(now)} of ${members.length - errored}${errored > 0 ? `, ${errored} errored` : ""}`;
      return `| ${group} | ${pass} |${compare ? ` ${delta}` : ""}`;
    }),
    "",
  ];
  const errors = groups(
    rows.filter((row) => row.error !== undefined),
    (row) => row.id,
  );
  const errorNote = `- Errored: ${errors.map(([id, failed]) => `${id} ×${failed.length}`).join(", ")}. These samples did not finish, even after retries, so pass rates leave them out; tokens they spent are counted.`;
  const nativeNote =
    "- native-subagent cases are approximate: the harness gives subagents their own system prompt, which this runner does not rebuild. T3's append is left out and its SubagentStart hook context added after the task.";
  const identityNote = `- The captured Claude Code identity line is replaced with "${NEUTRAL_IDENTITY}"`;
  const finished = rows.filter((row) => row.error === undefined).length;
  return [
    "# MCP tool-use eval\n",
    `- ${options.header}`,
    `- Pass: ${percent(passRate(rows))} of ${finished} samples.`,
    ...(errors.length > 0 ? [errorNote] : []),
    codex
      ? "- Cost: not applicable (subscription through proxy)."
      : `- Estimated cost $${cost.toFixed(2)}, $${(cost / rows.length).toFixed(3)} per sample.`,
    `- Agent tokens: ${agent.tokens}${codex ? "." : ` ($${agent.cost.toFixed(2)}).`}`,
    `- Shell simulator (${options.shellModel}) tokens: ${shell.tokens} (API-price estimate $${shell.cost.toFixed(2)}).`,
    ...(codex
      ? [
          "- Code-mode tools use case mocks and a simulated machine. Native subagent prompts and asynchronous notifications are approximate.",
        ]
      : [identityNote]),
    ...(rows.some((row) => row.role === "native-subagent") ? [nativeNote] : []),
    "",
    ...table("Cases", (row) => row.id, before !== undefined),
    ...table("By kind", (row) => row.kind),
    ...table("By pattern", (row) => row.pattern),
  ].join("\n");
};

const PositiveInt = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
const PositiveIntOrZero = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const Flags = Schema.Struct({
  model: Schema.Literals(Object.keys(MODELS) as Array<Model>),
  template: Schema.String,
  cases: Schema.optional(Schema.Array(Schema.String)),
  out: Schema.optional(Schema.String),
  baseline: Schema.optional(Schema.String),
  case: Schema.optional(Schema.Array(Schema.String)),
  samples: Schema.optional(PositiveInt),
  concurrency: PositiveInt,
  "max-steps": Schema.optional(PositiveInt),
  effort: Schema.optional(Schema.Literals(EFFORTS)),
  "shell-model": Schema.Literals(Object.keys(PRICES) as Array<PricedModel>),
  "user-instructions": Schema.Literals(["keep", "drop"]),
  "dry-run": Schema.Boolean,
  "stop-on-regression": Schema.Boolean,
  "regression-budget": Schema.optional(PositiveIntOrZero),
  context: Schema.Boolean,
});
const decodeFlags = Schema.decodeUnknownEffect(Flags);
const decodeCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(Capture));
const decodeCodexCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexCapture));
const decodeCase = Schema.decodeUnknownEffect(Schema.fromJsonString(McpToolUseCase));
const decodeBaselineRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      pass: Schema.Boolean,
      error: Schema.optional(Schema.String),
    }),
  ),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const string = { type: "string" } as const;

const main = Effect.gen(function* () {
  const { values } = NodeUtil.parseArgs({
    options: {
      model: { ...string, default: "claude-sonnet-5-5" },
      template: string,
      cases: { ...string, multiple: true },
      out: string,
      baseline: string,
      case: { ...string, multiple: true },
      // Unset: 2 samples per case, and a 3rd when those 2 disagree.
      samples: string,
      // Samples in flight at once, across all cases.
      concurrency: { ...string, default: "8" },
      // Unset: 6 for Claude, 10 for Codex, whose code-mode cells take more steps.
      "max-steps": string,
      effort: string,
      "shell-model": { ...string, default: "claude-haiku-5-5" },
      // T3's text must work for every user, so the captured CLAUDE.md is dropped by default.
      "user-instructions": { ...string, default: "drop" },
      "dry-run": { type: "boolean", default: false },
      "stop-on-regression": { type: "boolean", default: false },
      "regression-budget": string,
      // Prints the size of T3's text and tool schemas, then exits. Needs no template or key.
      context: { type: "boolean", default: false },
    },
  });
  const flags = yield* decodeFlags({ template: "", ...values });
  if (flags.context) {
    process.stdout.write(`${t3ContextReport(flags.model)}\n`);
    return;
  }
  if (flags["stop-on-regression"] && flags.baseline === undefined) {
    return yield* Effect.die(new Error("--stop-on-regression needs --baseline."));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readNdjson = <A, E>(file: string, decode: (line: string) => Effect.Effect<A, E>) =>
    fs.readFileString(file).pipe(
      Effect.map((content) => content.split("\n").filter((line) => line.trim() !== "")),
      Effect.flatMap((lines) => Effect.forEach(lines, (line) => decode(line))),
    );
  const casesDir = path.join(import.meta.dirname, "cases");
  const caseFiles =
    flags.cases ??
    (yield* fs.readDirectory(casesDir))
      .filter((name) => name.endsWith(".ndjson"))
      .toSorted()
      .map((name) => path.join(casesDir, name));
  const cases = (yield* Effect.forEach(caseFiles, (file) => readNdjson(file, decodeCase))).flat();
  const wanted = flags.case?.flatMap((ids) => ids.split(","));
  const codex = isCodex(flags.model);
  const harness = codex ? "codex" : "claude";
  const selected = cases.filter(
    ({ id, setup }) =>
      (wanted === undefined || wanted.includes(id)) &&
      (setup.harness === undefined || setup.harness === harness),
  );
  if (selected.length === 0) return yield* Effect.die(new Error("No case matches --case."));
  // Trimmed captures without user data ship beside the cases. `--template` also takes a raw
  // CLIProxyAPI capture.
  const templatePath =
    flags.template ||
    path.join(import.meta.dirname, "templates", codex ? "codex.json.gz" : "claude.json.gz");
  const templateBytes = yield* fs.readFile(templatePath);
  const template = new TextDecoder().decode(
    templatePath.endsWith(".gz") ? NodeZlib.gunzipSync(templateBytes) : templateBytes,
  );
  const keepUserInstructions = flags["user-instructions"] === "keep";
  const buildFor = (
    role: McpToolUseCase["setup"]["role"],
    deviceAccess: boolean,
    links: boolean,
  ): Effect.Effect<Base, Schema.SchemaError> =>
    codex
      ? decodeCodexCapture(template).pipe(
          Effect.map((capture) =>
            buildCodexBase(capture.request.provider_native, {
              model: flags.model,
              keepUserInstructions,
              effort: flags.effort,
              subagent: role === "delegated-child",
              links,
              deviceAccess,
            }),
          ),
        )
      : decodeCapture(template).pipe(
          Effect.flatMap((capture) => {
            const built = buildBase(capture.request.provider_native, {
              model: flags.model,
              keepUserInstructions,
              subagent: role === "delegated-child",
              nativeSubagent: role === "native-subagent",
              links,
              deviceAccess,
            });
            return role === "native-subagent"
              ? Effect.promise(() => t3SubagentContext(flags.model, deviceAccess)).pipe(
                  Effect.map((subagentContext): Base => ({ ...built, subagentContext })),
                )
              : Effect.succeed(built);
          }),
        );
  // Codex has no native subagents; its cases with that role run as top-level threads.
  const baseKey = ({ setup }: McpToolUseCase) =>
    `${codex && setup.role === "native-subagent" ? "top" : setup.role}:${setup.world?.deviceAgentAccess !== false}:${setup.linkedEnvironments === true}`;
  const base = yield* buildFor("top", true, false);
  const bases = new Map<string, Base>([["top:true:false", base]]);
  for (const testCase of selected) {
    const key = baseKey(testCase);
    if (bases.has(key)) continue;
    const [role = "top", access, links] = key.split(":") as [
      McpToolUseCase["setup"]["role"],
      string,
      string,
    ];
    bases.set(key, yield* buildFor(role, access === "true", links === "true"));
  }
  const baseFor = (testCase: McpToolUseCase) => bases.get(baseKey(testCase)) ?? base;
  const effort = flags.effort ?? base.codex?.reasoning.effort ?? "high";
  if (flags["dry-run"]) {
    // One JSON line per case. Without --case this also checks that every case builds.
    for (const testCase of selected) {
      const sample = makeSample(testCase, baseFor(testCase));
      yield* Effect.scoped(withDevices(sample));
      const messages = buildMessages(sample);
      const body = sample.base.codex
        ? codexRequest(sample.base, codexMessages(messages))
        : requestBody(sample, effort, messages);
      process.stdout.write(`${yield* encodeJson(body)}\n`);
    }
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const out = flags.out;
  if ((!apiKey && !codex) || out === undefined) {
    const message =
      "Set ANTHROPIC_API_KEY and pass --out <directory>. ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are never used.";
    return yield* Effect.die(new Error(message));
  }
  const config: Config = {
    apiKey,
    model: flags.model,
    ...(codex ? { proxy: proxyConfig() } : {}),
    effort,
    maxSteps: flags["max-steps"] ?? (codex ? 10 : 6),
    shellModel: flags["shell-model"],
  };
  const previous =
    flags.baseline === undefined ? [] : yield* readNdjson(flags.baseline, decodeBaselineRow);
  const baseline = new Map(
    groups(previous, (row) => row.id)
      .map(([id, r]) => [id, passRate(r)] as const)
      .filter(([, rate]) => !Number.isNaN(rate)),
  );
  // Only a case that passed every baseline sample can stop a run; flaky ones are just reported.
  const passedBefore = (id: string) => baseline.get(id) === 1;
  // Before the paid runs, so a missing git cannot lose their results.
  const commit = yield* Effect.try(() =>
    NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
      encoding: "utf8",
    }).trim(),
  ).pipe(Effect.orElseSucceed(() => "unknown"));
  const inFlight = yield* Semaphore.make(flags.concurrency);
  const runOne = (testCase: McpToolUseCase) => {
    const { id, kind, pattern } = testCase;
    const identity = { id, kind, pattern, role: testCase.setup.role };
    const usage = { usage: emptyUsage(), shellUsage: emptyUsage() };
    const privateValues = [config.apiKey, ...Object.values(config.proxy?.headers ?? {})]
      .flatMap((value) => [value, value.replace(/^Bearer /i, "")])
      .filter(Boolean);
    return runSample(testCase, config, baseFor(testCase), usage).pipe(
      inFlight.withPermits(1),
      Effect.matchCause({
        // Not graded: a sample that errors is left out of pass rates, with its tokens so far.
        onFailure: (cause) => ({
          ...identity,
          ...usage,
          pass: false,
          error: privateValues.reduce(
            (message, value) => message.replaceAll(value, "[redacted]"),
            Cause.pretty(cause),
          ),
        }),
        onSuccess: (sample) => {
          const checks = gradeSample(testCase.expect, sample);
          return { ...identity, pass: checks.every((check) => check.pass), checks, ...sample };
        },
      }),
      Effect.tap((row) =>
        Effect.log(`${row.id}: ${"error" in row ? "ERROR" : row.pass ? "pass" : "FAIL"}`),
      ),
    );
  };
  // Without --samples, a case whose 2 samples disagree gets a 3rd to settle it.
  const runCase = Effect.fn("evaluateMcpToolUse.runCase")(function* (testCase: McpToolUseCase) {
    const samples = Array.from({ length: flags.samples ?? 2 }, () => testCase);
    const first = yield* Effect.forEach(samples, runOne, { concurrency: "unbounded" });
    const split = flags.samples === undefined && new Set(first.map((row) => row.pass)).size > 1;
    return split ? [...first, yield* runOne(testCase)] : first;
  });
  // --stop-on-regression runs cases that passed in the baseline first and stops once more than
  // --regression-budget of them fail, so a copy change that breaks passing cases fails fast.
  // A budget lets a quirky model miss a case or two without ending the run.
  const stopEarly = flags["stop-on-regression"];
  const budget = flags["regression-budget"] ?? 0;
  const ordered = stopEarly
    ? selected.toSorted((a, b) => Number(passedBefore(b.id)) - Number(passedBefore(a.id)))
    : selected;
  const rows: Array<Effect.Success<ReturnType<typeof runOne>>> = [];
  const regressions: Array<string> = [];
  yield* Effect.forEach(
    ordered,
    (testCase) =>
      runCase(testCase).pipe(
        Effect.flatMap((caseRows) => {
          rows.push(...caseRows);
          // A case whose samples all errored has no rate, so it is no regression either.
          if (!stopEarly || !passedBefore(testCase.id) || !(passRate(caseRows) <= 0.5)) {
            return Effect.void;
          }
          regressions.push(testCase.id);
          return regressions.length > budget ? Effect.fail(testCase.id) : Effect.void;
        }),
      ),
    { concurrency: flags.concurrency, discard: true },
  ).pipe(Effect.ignore);
  const samples = flags.samples === undefined ? "2-3 (adaptive)" : flags.samples;
  const header = `Commit \`${commit}\`, ${flags.model} at ${effort} effort, user instructions ${flags["user-instructions"]}, ${samples} samples per case, template \`${path.basename(templatePath)}\``;
  const finished = new Set(rows.map((row) => row.id)).size;
  const stopped =
    regressions.length === 0
      ? []
      : [
          `- Regressions (passed every baseline sample, now fail): ${regressions.map((id) => `\`${id}\``).join(", ")}.${regressions.length > budget ? ` Stopped with ${finished} of ${selected.length} cases finished.` : ""}`,
        ];
  const summary = summarize(
    rows,
    {
      header: [header, t3ContextReport(flags.model), ...stopped].join("\n"),
      shellModel: config.shellModel,
      model: config.model,
    },
    flags.baseline === undefined ? undefined : baseline,
  );
  yield* fs.makeDirectory(out, { recursive: true });
  const lines = yield* Effect.forEach(rows, (row) => encodeJson(row));
  yield* fs.writeFileString(path.join(out, "results.jsonl"), `${lines.join("\n")}\n`);
  yield* fs.writeFileString(path.join(out, "summary.md"), summary);
  yield* Effect.log(`Wrote ${rows.length} samples to ${out}.\n\n${summary}`);
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
