import * as NodeOS from "node:os";

import { CODEX_THREAD_CONFIG } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { revertCodexThread } from "../src/provider/CodexThreadRevert.ts";
import { buildCodexInitializeParams } from "../src/provider/CodexProvider.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  PLAN_QUESTIONS_PROMPT,
  PROPOSED_PLAN_PROMPT,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  SIMPLE_PROMPT,
  SUBAGENT_CONTINUE_PARENT_PROMPT,
  SUBAGENT_CONTINUE_PROMPT,
  SUBAGENT_PROMPT,
  SUBAGENT_V2_APPROVAL_PROMPT,
  SUBAGENT_V2_PROMPT,
  SUBAGENT_V2_NESTED_APPROVAL_PROMPT,
  SUBAGENT_V2_NESTED_PROMPT,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT,
  TODO_LIST_PROMPT,
  TOOL_CALL_WRITE_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  COMMAND_OUTPUT_STREAMING_PROMPT,
  TURN_INTERRUPT_PROMPT,
  WEB_SEARCH_PROMPT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { codexReplayRecordingOutputRecords } from "./codexReplayRecordingRecords.ts";
import { makeReplayRecorderDeferredRegistry } from "./replayRecorderDeferredRegistry.ts";
import { scenarios } from "./record-codex-app-server-replay-fixtureParts.ts";
import { runReplaySession } from "./record-codex-app-server-replay-fixtureParts2.ts";

const CODEX_REPLAY_PLAN_MODE_DEVELOPER_INSTRUCTIONS =
  process.env.T3_CODEX_REPLAY_PLAN_DEVELOPER_INSTRUCTIONS ??
  "You are in Plan mode. Prefer request_user_input for clarifying questions. When presenting a complete plan, wrap it in <proposed_plan> and </proposed_plan>.";
// Match V2 adapter frames so recordings replay unchanged.
export const CODEX_CLIENT_CAPABILITIES = {
  experimentalApi: true,
  optOutNotificationMethods: ["turn/diff/updated"],
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
} as const;
const CODEX_REPLAY_DEFAULT_MODEL = "gpt-6-luna";
const CODEX_REPLAY_MODEL_OVERRIDE = readArgValue("--model") ?? process.env.T3_CODEX_REPLAY_MODEL;

const SCENARIO_NAMES = [
  "simple",
  "tool_call_read_only_on_request",
  "tool_call_workspace_never",
  "tool_call_restricted_granular",
  "subagent",
  "subagent_continue",
  "subagent_v2",
  "subagent_v2_approval",
  "subagent_v2_nested",
  "subagent_v2_nested_approval",
  "multi_turn",
  "queued_turn",
  "provider_thread_resume",
  "todo_list",
  "web_search",
  "plan_questions",
  "proposed_plan",
  "message_steering",
  "turn_interrupt",
  "turn_interrupt_mid_tool",
  "command_output_streaming",
  "thread_rollback",
  "thread_rollback_after_restart",
  "thread_rollback_to_stopped_turn",
  "thread_merge_back_siblings",
] as const;

type ScenarioName = (typeof SCENARIO_NAMES)[number];
export type TurnStartParams = CodexSchema.ClientRequestParamsByMethod["turn/start"] & {
  readonly collaborationMode?: CodexSchema.V2TurnStartParams__CollaborationMode;
};
type TurnStartInput = TurnStartParams["input"];
type TurnStartResponse = CodexSchema.ClientRequestResponsesByMethod["turn/start"];
type SandboxPolicy = NonNullable<TurnStartParams["sandboxPolicy"]>;
type ApprovalPolicy = NonNullable<TurnStartParams["approvalPolicy"]>;

export interface ReplayRun {
  readonly name: string;
  readonly prompt?: string;
  readonly description: string;
  readonly steps: ReadonlyArray<ReplayStep>;
  readonly turnDefaults?: Omit<TurnStartParams, "input" | "threadId">;
  readonly interactionMode?: "plan";
  /** Recorder overrides; replay ignores keys listed in the header's `recorderThreadConfigKeys`. */
  readonly threadConfig?: Readonly<Record<string, boolean | number | string>>;
}

type ReplayStep =
  | {
      readonly type: "turn";
      readonly label: string;
      readonly prompt: string;
      readonly thread?: string;
      readonly turnOverrides?: Omit<TurnStartParams, "input" | "threadId">;
    }
  | {
      readonly type: "steeredTurn";
      readonly label: string;
      readonly prompt: string;
      readonly steer: string;
      readonly turnOverrides?: Omit<TurnStartParams, "input" | "threadId">;
    }
  | {
      readonly type: "interruptedTurn";
      readonly label: string;
      readonly prompt: string;
      readonly interruptAfterMs?: number;
      readonly interruptAfterCommandExecutionStarted?: boolean;
      readonly turnOverrides?: Omit<TurnStartParams, "input" | "threadId">;
    }
  | {
      readonly type: "rollback";
      readonly label: string;
      readonly numTurns: number;
    }
  | {
      readonly type: "fork";
      readonly label: string;
      readonly from?: string;
      readonly as?: string;
    };
export type TurnReplayStep = Exclude<
  ReplayStep,
  { readonly type: "rollback" } | { readonly type: "fork" }
>;

export interface ReplayScenario {
  readonly name: ScenarioName;
  readonly fileName: `${ScenarioName}.ndjson`;
  readonly description: string;
  readonly model?: string;
  readonly runs: ReadonlyArray<ReplayRun>;
}

export interface Recorder {
  readonly path: string;
  readonly setVersion: (version: string) => Effect.Effect<void>;
  readonly writeRecord: (
    record: Record<string, unknown>,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly flush: () => Effect.Effect<void, PlatformError.PlatformError>;
}

function readArgValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readArgValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function defaultTranscriptUrl(scenario: ReplayScenario): URL {
  return new URL(
    `../src/orchestration-v2/testkit/fixtures/${scenario.name}/codex_transcript.ndjson`,
    import.meta.url,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseScenarios(): ReadonlyArray<ScenarioName> {
  const rawValues = [
    ...readArgValues("--scenario"),
    ...(process.env.T3_CODEX_REPLAY_SCENARIOS ? [process.env.T3_CODEX_REPLAY_SCENARIOS] : []),
  ];
  const requested = rawValues.length > 0 ? rawValues : ["simple"];
  const names = requested.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

  if (names.includes("all")) {
    return SCENARIO_NAMES;
  }

  const expandedNames = names.flatMap((name) =>
    name === "tool_call"
      ? [
          "tool_call_read_only_on_request",
          "tool_call_workspace_never",
          "tool_call_restricted_granular",
        ]
      : [name],
  );

  const invalid = expandedNames.filter(
    (name): name is string => !SCENARIO_NAMES.includes(name as ScenarioName),
  );
  if (invalid.length > 0) {
    throw new Error(`Unknown scenario(s): ${invalid.join(", ")}`);
  }

  return [...new Set(expandedNames)] as ReadonlyArray<ScenarioName>;
}

function classifyJsonRpcPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return "unknown";
  }
  if (typeof payload.method === "string" && "id" in payload) {
    return "request";
  }
  if (typeof payload.method === "string") {
    return "notification";
  }
  if ("id" in payload && "error" in payload) {
    return "error_response";
  }
  if ("id" in payload && "result" in payload) {
    return "response";
  }
  return "unknown";
}

function protocolMethod(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.method === "string" ? payload.method : undefined;
}

function protocolId(payload: unknown): string | number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  return typeof payload.id === "string" || typeof payload.id === "number" ? payload.id : undefined;
}

function protocolResult(payload: unknown): unknown {
  return isRecord(payload) && "result" in payload ? payload.result : undefined;
}

function inferCodexVersion(payload: unknown): string | undefined {
  const result = protocolResult(payload);
  if (!isRecord(result)) {
    return undefined;
  }

  if (typeof result.userAgent === "string") {
    const match = result.userAgent.match(/\/([0-9][^\s)]*)/u);
    if (match?.[1]) {
      return match[1];
    }
  }

  const thread = result.thread;
  return isRecord(thread) && typeof thread.cliVersion === "string" ? thread.cliVersion : undefined;
}

export function turnInput(prompt: string): TurnStartInput {
  return [{ type: "text", text: prompt }];
}

export function getTurnId(response: TurnStartResponse): string {
  return response.turn.id;
}

export function readOnlyFullAccessSandbox(): SandboxPolicy {
  return {
    networkAccess: false,
    type: "readOnly",
  };
}

export function readOnlyRestrictedSandbox(): SandboxPolicy {
  return {
    networkAccess: false,
    type: "readOnly",
  };
}

export function workspaceWriteSandbox(): SandboxPolicy {
  return {
    networkAccess: false,
    type: "workspaceWrite",
    writableRoots: [],
  };
}

export function granularApprovalPolicy(): ApprovalPolicy {
  return {
    granular: {
      mcp_elicitations: true,
      request_permissions: true,
      rules: true,
      sandbox_approval: true,
      skill_approval: true,
    },
  };
}

export function scenarioModel(scenario: ReplayScenario): string {
  return CODEX_REPLAY_MODEL_OVERRIDE ?? scenario.model ?? CODEX_REPLAY_DEFAULT_MODEL;
}

export function planCollaborationMode(model: string): CodexSchema.V2TurnStartParams__CollaborationMode {
  return {
    mode: "plan",
    settings: {
      developer_instructions: CODEX_REPLAY_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      model,
      reasoning_effort: "medium",
    },
  };
}

function recorderThreadConfigMetadata(scenario: ReplayScenario) {
  const keys = [...new Set(scenario.runs.flatMap((run) => Object.keys(run.threadConfig ?? {})))];
  return keys.length === 0 ? {} : { recorderThreadConfigKeys: keys };
}

const makeRecorder = Effect.fn("record-codex-app-server-replay-fixture.makeRecorder")(function* ({
  outPath,
  scenario,
  checkout,
}: {
  readonly outPath: string;
  readonly scenario: ReplayScenario;
  readonly checkout: string;
}): Effect.fn.Return<Recorder, PlatformError.PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  let version = "unknown";
  const records: Array<Record<string, unknown>> = [];
  const setVersion = (nextVersion: string) =>
    Effect.sync(() => {
      version = nextVersion;
    });
  const writeRecord = (record: Record<string, unknown>) =>
    Effect.sync(() => {
      records.push(record);
    });
  const flush = () => {
    const outputRecords = codexReplayRecordingOutputRecords(records, {
      workspace: process.cwd(),
      machine: {
        home: NodeOS.homedir(),
        hostname: NodeOS.hostname(),
        checkout,
      },
    });
    return fs.writeFileString(
      outPath,
      `${[
        {
          type: "transcript_start",
          provider: "codex",
          protocol: "codex.app-server",
          version,
          scenario: scenario.name,
          metadata: {
            source: "record-codex-app-server-replay-fixture",
            fileName: scenario.fileName,
            description: scenario.description,
            model: scenarioModel(scenario),
            ...recorderThreadConfigMetadata(scenario),
          },
        },
        ...outputRecords,
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
  };

  return { path: outPath, setVersion, writeRecord, flush };
});

export function layerCodex({ recorder }: { readonly recorder: Recorder }) {
  const clientRequestMethodById = new Map<string, string>();
  const serverRequestMethodById = new Map<string, string>();
  const clientOptions: CodexClient.CodexAppServerClientOptions = {
    logIncoming: true,
    logOutgoing: true,
    logger: Effect.fn("logger")(function (event) {
      if (event.stage === "raw") {
        return Effect.void;
      }

      const id = protocolId(event.payload);
      const idKey = id === undefined ? undefined : String(id);
      const method = protocolMethod(event.payload);
      const messageKind = classifyJsonRpcPayload(event.payload);
      let correlatedRequestMethod: string | undefined;

      if (messageKind === "request" && idKey && method) {
        if (event.direction === "outgoing") {
          clientRequestMethodById.set(idKey, method);
        } else {
          serverRequestMethodById.set(idKey, method);
        }
      }

      if (messageKind === "response" || messageKind === "error_response") {
        if (event.direction === "incoming" && idKey) {
          correlatedRequestMethod = clientRequestMethodById.get(idKey);
          clientRequestMethodById.delete(idKey);
        }
        if (event.direction === "outgoing" && idKey) {
          correlatedRequestMethod = serverRequestMethodById.get(idKey);
          serverRequestMethodById.delete(idKey);
        }
      }

      const version = inferCodexVersion(event.payload);
      const updateVersion = version ? recorder.setVersion(version) : Effect.void;

      const label = method ?? correlatedRequestMethod;
      const record =
        event.direction === "outgoing"
          ? {
              type: "expect_outbound",
              ...(label ? { label } : {}),
              frame: event.payload,
            }
          : {
              type: "emit_inbound",
              ...(label ? { label } : {}),
              frame: event.payload,
            };

      return Effect.gen(function* () {
        yield* updateVersion;
        yield* recorder.writeRecord(record);
      }).pipe(Effect.ignore);
    }),
  };

  return Layer.effect(
    CodexClient.CodexAppServerClient,
    Effect.gen(function* () {
      // Inheriting the vp shim's VP_TOOL_RECURSION makes Codex's shell `node` calls fail.
      const { VP_TOOL_RECURSION: _vpToolRecursion, ...environment } =
        yield* HostProcess.Environment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const commandName = environment.T3_CODEX_BIN ?? environment.CODEX_BIN ?? "codex";
      const spawnCommand = yield* resolveSpawnCommand(commandName, ["app-server"], {
        env: environment,
      });
      const handle = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: process.cwd(),
          env: environment,
          shell: spawnCommand.shell,
        }),
      );
      const context = yield* Layer.build(CodexClient.layerChildProcess(handle, clientOptions));
      return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context));
    }),
  );
}

export function installReplayHandlers({
  client,
  startTurn,
  completeTurn,
  startCommandExecution,
  beforeApprovalResponse,
  runningCommandProcessIds,
}: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly startTurn: (turnId: string) => Effect.Effect<void>;
  readonly completeTurn: (turnId: string) => Effect.Effect<void>;
  readonly startCommandExecution: (turnId: string) => Effect.Effect<void>;
  readonly beforeApprovalResponse: () => Effect.Effect<void>;
  readonly runningCommandProcessIds: Map<string, Map<string, string>>;
}) {
  return Effect.all(
    [
      client.handleServerRequest("item/tool/requestUserInput", (payload) =>
        Effect.succeed({
          answers: Object.fromEntries(
            payload.questions.map((question) => [
              question.id,
              {
                answers:
                  question.options && question.options.length > 0
                    ? [question.options[0]!.label]
                    : ["ok"],
              },
            ]),
          ),
        }),
      ),
      client.handleServerRequest("item/commandExecution/requestApproval", () =>
        beforeApprovalResponse().pipe(Effect.as({ decision: "accept" })),
      ),
      client.handleServerRequest("item/fileChange/requestApproval", () =>
        beforeApprovalResponse().pipe(Effect.as({ decision: "accept" })),
      ),
      client.handleServerRequest("item/permissions/requestApproval", (payload) =>
        beforeApprovalResponse().pipe(
          Effect.as({
            permissions: payload.permissions,
            scope: "turn" as const,
          }),
        ),
      ),
      client.handleServerRequest("mcpServer/elicitation/request", () =>
        Effect.succeed({ action: "accept" }),
      ),
      client.handleServerRequest("item/tool/call", (payload) =>
        Effect.succeed({
          contentItems: [
            {
              text: `Replay dynamic tool handler did not execute external tool: ${payload.tool}`,
              type: "inputText" as const,
            },
          ],
          success: false,
        }),
      ),
      client.handleServerRequest("applyPatchApproval", () =>
        Effect.succeed({ decision: "approved" }),
      ),
      client.handleServerRequest("execCommandApproval", () =>
        Effect.succeed({ decision: "approved" }),
      ),
      client.handleUnknownServerRequest((method) =>
        Effect.die(new Error(`Unhandled Codex app-server request in replay recorder: ${method}`)),
      ),
      client.handleServerNotification("turn/started", (payload) =>
        startTurn(payload.turn.id).pipe(Effect.ignore),
      ),
      client.handleServerNotification("turn/completed", (payload) =>
        completeTurn(payload.turn.id).pipe(Effect.ignore),
      ),
      client.handleServerNotification("item/completed", (payload) => {
        if (payload.item.type !== "commandExecution") return Effect.void;
        runningCommandProcessIds.get(payload.turnId)?.delete(payload.item.id);
        return startCommandExecution(payload.turnId).pipe(Effect.ignore);
      }),
      client.handleServerNotification("item/started", (payload) => {
        if (payload.item.type !== "commandExecution") return Effect.void;
        const processId = payload.item.processId;
        if (payload.item.status === "inProgress" && typeof processId === "string") {
          const running = runningCommandProcessIds.get(payload.turnId) ?? new Map();
          running.set(payload.item.id, processId);
          runningCommandProcessIds.set(payload.turnId, running);
        }
        return startCommandExecution(payload.turnId).pipe(Effect.ignore);
      }),
    ],
    { discard: true },
  );
}

const runScenario = Effect.fn("record-codex-app-server-replay-fixture.runScenario")(function* ({
  scenario,
  outPath,
}: {
  readonly scenario: ReplayScenario;
  readonly outPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = path.resolve(yield* path.fromFileUrl(new URL("../../..", import.meta.url)));
  const recorder = yield* makeRecorder({ outPath, scenario, checkout });

  yield* fs.makeDirectory(path.dirname(outPath), { recursive: true });
  yield* Console.log(`Writing ${scenario.name} Codex replay events to ${recorder.path}`);

  yield* Effect.forEach(scenario.runs, (run) => runReplaySession({ scenario, run, recorder }), {
    concurrency: 1,
  });

  yield* recorder.writeRecord({
    type: "runtime_exit",
    status: "success",
  });
  yield* recorder.flush();
});

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const requestedScenarios = parseScenarios();
  const allScenarios = scenarios();
  const outDir = readArgValue("--out-dir") ?? process.env.T3_CODEX_REPLAY_OUT_DIR;
  const singleOutPath = readArgValue("--out") ?? process.env.T3_CODEX_REPLAY_OUT;
  const selected = allScenarios.filter((scenario) => requestedScenarios.includes(scenario.name));

  if (selected.length === 0) {
    throw new Error("No replay scenarios selected.");
  }
  if (singleOutPath && selected.length !== 1) {
    throw new Error("--out / T3_CODEX_REPLAY_OUT can only be used with exactly one --scenario.");
  }

  yield* Effect.forEach(
    selected,
    (scenario) =>
      Effect.gen(function* () {
        const defaultOutPath = yield* path.fromFileUrl(defaultTranscriptUrl(scenario));
        yield* runScenario({
          scenario,
          outPath:
            singleOutPath ?? (outDir ? path.join(outDir, scenario.fileName) : defaultOutPath),
        });
      }),
    { concurrency: 1 },
  );
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
