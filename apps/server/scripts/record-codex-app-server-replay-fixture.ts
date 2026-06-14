import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_FIRST_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_SECOND_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_SIBLINGS_FIRST_PROMPT,
  THREAD_FORK_NATIVE_SIBLINGS_SECOND_PROMPT,
  THREAD_FORK_NATIVE_SIBLINGS_SOURCE_PROMPT,
  THREAD_MERGE_BACK_FORK_PROMPT,
  THREAD_MERGE_BACK_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_RECALL_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT,
  THREAD_MERGE_BACK_SOURCE_PROMPT,
  TODO_LIST_PROMPT,
  TOOL_CALL_WRITE_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  TURN_INTERRUPT_PROMPT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";

const CODEX_REPLAY_PLAN_MODE_DEVELOPER_INSTRUCTIONS =
  process.env.T3_CODEX_REPLAY_PLAN_DEVELOPER_INSTRUCTIONS ??
  "You are in Plan mode. Prefer request_user_input for clarifying questions. When presenting a complete plan, wrap it in <proposed_plan> and </proposed_plan>.";
const CODEX_CLIENT_INFO = {
  name: "t3code_desktop",
  title: "T3 Code Desktop",
  version: "0.1.0",
} as const;
const CODEX_CLIENT_CAPABILITIES = {
  experimentalApi: true,
} as const;

const SCENARIO_NAMES = [
  "simple",
  "tool_call_read_only_on_request",
  "tool_call_workspace_never",
  "tool_call_restricted_granular",
  "subagent",
  "subagent_continue",
  "multi_turn",
  "provider_thread_resume",
  "todo_list",
  "plan_questions",
  "proposed_plan",
  "message_steering",
  "turn_interrupt",
  "turn_interrupt_mid_tool",
  "thread_rollback",
  "thread_fork_native_continue",
  "thread_fork_native_siblings",
  "thread_merge_back_continue",
  "thread_merge_back_siblings",
] as const;

type ScenarioName = (typeof SCENARIO_NAMES)[number];
type TurnStartParams = CodexSchema.ClientRequestParamsByMethod["turn/start"] & {
  readonly collaborationMode?: CodexSchema.V2TurnStartParams__CollaborationMode;
};
type TurnStartInput = TurnStartParams["input"];
type TurnStartResponse = CodexSchema.ClientRequestResponsesByMethod["turn/start"];
type SandboxPolicy = NonNullable<TurnStartParams["sandboxPolicy"]>;
type ApprovalPolicy = NonNullable<TurnStartParams["approvalPolicy"]>;

interface ReplayRun {
  readonly name: string;
  readonly prompt?: string;
  readonly description: string;
  readonly steps: ReadonlyArray<ReplayStep>;
  readonly turnDefaults?: Omit<TurnStartParams, "input" | "threadId">;
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
type TurnReplayStep = Exclude<
  ReplayStep,
  { readonly type: "rollback" } | { readonly type: "fork" }
>;

interface ReplayScenario {
  readonly name: ScenarioName;
  readonly fileName: `${ScenarioName}.ndjson`;
  readonly description: string;
  readonly runs: ReadonlyArray<ReplayRun>;
}

interface Recorder {
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

function defaultTranscriptPath(scenario: ReplayScenario): string {
  return new URL(
    `../src/orchestration-v2/testkit/fixtures/${scenario.name}/codex_transcript.ndjson`,
    import.meta.url,
  ).pathname;
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

function turnInput(prompt: string): TurnStartInput {
  return [{ type: "text", text: prompt }];
}

function getTurnId(response: TurnStartResponse): string {
  return response.turn.id;
}

function readOnlyFullAccessSandbox(): SandboxPolicy {
  return {
    networkAccess: false,
    type: "readOnly",
  };
}

function readOnlyRestrictedSandbox(): SandboxPolicy {
  return {
    networkAccess: false,
    type: "readOnly",
  };
}

function workspaceWriteSandbox(): SandboxPolicy {
  return {
    networkAccess: false,
    type: "workspaceWrite",
    writableRoots: [],
  };
}

function granularApprovalPolicy(): ApprovalPolicy {
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

function collaborationMode(
  mode: Extract<CodexSchema.V2TurnStartParams__ModeKind, "plan">,
): CodexSchema.V2TurnStartParams__CollaborationMode {
  return {
    mode,
    settings: {
      developer_instructions: CODEX_REPLAY_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      model: "gpt-5.4",
      reasoning_effort: "medium",
    },
  };
}

function scenarios(): ReadonlyArray<ReplayScenario> {
  return [
    {
      name: "simple",
      fileName: "simple.ndjson",
      description: "One thread and one turn with a deterministic text-only response.",
      runs: [
        {
          name: "simple",
          description: "Single text-only turn.",
          prompt: SIMPLE_PROMPT,
          steps: [{ type: "turn", label: "simple", prompt: SIMPLE_PROMPT }],
        },
      ],
    },
    {
      name: "tool_call_read_only_on_request",
      fileName: "tool_call_read_only_on_request.ndjson",
      description:
        "Write a small fixture file with read-only full filesystem visibility and on-request approvals.",
      runs: [
        {
          name: "read-only-on-request",
          description:
            "Write action under read-only full filesystem visibility with on-request approvals.",
          prompt: TOOL_CALL_WRITE_PROMPT,
          turnDefaults: {
            approvalPolicy: "on-request",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "write-fixture-file", prompt: TOOL_CALL_WRITE_PROMPT }],
        },
      ],
    },
    {
      name: "tool_call_workspace_never",
      fileName: "tool_call_workspace_never.ndjson",
      description:
        "Write a small fixture file with workspace-write sandbox policy and never approvals.",
      runs: [
        {
          name: "workspace-never",
          description:
            "Write action under workspace-write policy with never approvals for baseline no-prompt behavior.",
          prompt: TOOL_CALL_WRITE_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [{ type: "turn", label: "write-fixture-file", prompt: TOOL_CALL_WRITE_PROMPT }],
        },
      ],
    },
    {
      name: "tool_call_restricted_granular",
      fileName: "tool_call_restricted_granular.ndjson",
      description:
        "Write a small fixture file with restricted read access and granular approval flags enabled.",
      runs: [
        {
          name: "restricted-granular",
          description:
            "Write action under restricted read access with granular approval flags enabled, intended to capture permission request flows when Codex escalates.",
          prompt: TOOL_CALL_WRITE_PROMPT,
          turnDefaults: {
            approvalPolicy: granularApprovalPolicy(),
            sandboxPolicy: readOnlyRestrictedSandbox(),
          },
          steps: [
            {
              type: "turn",
              label: "write-fixture-file",
              prompt: TOOL_CALL_WRITE_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "subagent",
      fileName: "subagent.ndjson",
      description: "One root turn that asks Codex to spawn two collab agents.",
      runs: [
        {
          name: "two-subagents",
          description: "Root turn asks for two subagents reading different files.",
          prompt: SUBAGENT_PROMPT,
          turnDefaults: {
            approvalPolicy: "on-request",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "spawn-two-subagents", prompt: SUBAGENT_PROMPT }],
        },
      ],
    },
    {
      name: "subagent_continue",
      fileName: "subagent_continue.ndjson",
      description:
        "A root turn spawns one native Codex subagent, then a later root turn resumes and messages the same child thread.",
      runs: [
        {
          name: "continued-subagent",
          description:
            "The second root turn asks Codex to continue the subagent created by the first root turn.",
          steps: [
            {
              type: "turn",
              label: "spawn-subagent",
              prompt: SUBAGENT_CONTINUE_PROMPT,
            },
            {
              type: "turn",
              label: "continue-subagent",
              prompt: SUBAGENT_CONTINUE_PARENT_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "multi_turn",
      fileName: "multi_turn.ndjson",
      description: "One thread with two sequential user turns.",
      runs: [
        {
          name: "two-turns-same-thread",
          description: "Second turn starts after the first root turn completes.",
          steps: [
            {
              type: "turn",
              label: "first",
              prompt: MULTI_TURN_FIRST_PROMPT,
            },
            {
              type: "turn",
              label: "second",
              prompt: MULTI_TURN_SECOND_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "provider_thread_resume",
      fileName: "provider_thread_resume.ndjson",
      description:
        "One provider-native thread is started, completed, then resumed by thread id in a fresh app-server session.",
      runs: [
        {
          name: "resume-provider-thread",
          description:
            "First turn completes, the app-server runtime is restarted, thread/resume loads the existing provider thread, then a second turn completes.",
          steps: [
            {
              type: "turn",
              label: "first-before-resume",
              prompt: PROVIDER_THREAD_RESUME_FIRST_PROMPT,
            },
            {
              type: "turn",
              label: "second-after-resume",
              prompt: PROVIDER_THREAD_RESUME_SECOND_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "todo_list",
      fileName: "todo_list.ndjson",
      description: "One turn that asks Codex to emit progress through update_plan.",
      runs: [
        {
          name: "todo-list",
          description: "Default-mode turn that should surface turn/plan/updated notifications.",
          prompt: TODO_LIST_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "todo-list", prompt: TODO_LIST_PROMPT }],
        },
      ],
    },
    {
      name: "plan_questions",
      fileName: "plan_questions.ndjson",
      description: "One plan-mode turn that asks a structured clarifying question.",
      runs: [
        {
          name: "plan-questions",
          description: "Plan-mode turn intended to surface item/tool/requestUserInput.",
          prompt: PLAN_QUESTIONS_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            collaborationMode: collaborationMode("plan"),
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "plan-questions", prompt: PLAN_QUESTIONS_PROMPT }],
        },
      ],
    },
    {
      name: "proposed_plan",
      fileName: "proposed_plan.ndjson",
      description: "One plan-mode turn that emits a proposed plan document.",
      runs: [
        {
          name: "proposed-plan",
          description:
            "Plan-mode turn intended to surface item/plan/delta and completed plan item.",
          prompt: PROPOSED_PLAN_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            collaborationMode: collaborationMode("plan"),
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "proposed-plan", prompt: PROPOSED_PLAN_PROMPT }],
        },
      ],
    },
    {
      name: "message_steering",
      fileName: "message_steering.ndjson",
      description: "One active turn receives an immediate turn/steer request.",
      runs: [
        {
          name: "immediate-steer",
          description: "Start a turn, then immediately steer the active root turn.",
          steps: [
            {
              type: "steeredTurn",
              label: "steered",
              prompt: MESSAGE_STEERING_INITIAL_PROMPT,
              steer: MESSAGE_STEERING_STEER_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "turn_interrupt",
      fileName: "turn_interrupt.ndjson",
      description: "One active turn is interrupted before it finishes naturally.",
      runs: [
        {
          name: "interrupt-active-turn",
          description: "Start a long-running turn, then send turn/interrupt.",
          prompt: TURN_INTERRUPT_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [
            {
              type: "interruptedTurn",
              label: "interrupt-active-turn",
              prompt: TURN_INTERRUPT_PROMPT,
              interruptAfterMs: 1_500,
            },
          ],
        },
      ],
    },
    {
      name: "turn_interrupt_mid_tool",
      fileName: "turn_interrupt_mid_tool.ndjson",
      description:
        "One active turn is interrupted after Codex has already executed a local command.",
      runs: [
        {
          name: "interrupt-after-command-execution",
          description: "Start a turn, wait for command execution, then send turn/interrupt.",
          prompt: TURN_INTERRUPT_MID_TOOL_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [
            {
              type: "interruptedTurn",
              label: "interrupt-after-command-execution",
              prompt: TURN_INTERRUPT_MID_TOOL_PROMPT,
              interruptAfterCommandExecutionStarted: true,
            },
          ],
        },
      ],
    },
    {
      name: "thread_rollback",
      fileName: "thread_rollback.ndjson",
      description:
        "One thread completes two turns, rolls back the most recent turn, then starts another turn.",
      runs: [
        {
          name: "rollback-one-turn",
          description:
            "Two completed turns, thread/rollback numTurns=1, then a post-rollback turn.",
          steps: [
            {
              type: "turn",
              label: "first-before-rollback",
              prompt: THREAD_ROLLBACK_FIRST_PROMPT,
            },
            {
              type: "turn",
              label: "second-before-rollback",
              prompt: THREAD_ROLLBACK_SECOND_PROMPT,
            },
            {
              type: "rollback",
              label: "rollback-latest-turn",
              numTurns: 1,
            },
            {
              type: "turn",
              label: "post-rollback",
              prompt: THREAD_ROLLBACK_AFTER_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "thread_fork_native_continue",
      fileName: "thread_fork_native_continue.ndjson",
      description:
        "One source marker turn, a native thread fork, a fork-local marker turn, and a recall turn that requires both contexts.",
      runs: [
        {
          name: "continue-native-fork",
          description:
            "Proves the native fork inherits source context and retains its own first turn into a second fork-local turn.",
          steps: [
            {
              type: "turn",
              label: "source",
              prompt: THREAD_FORK_NATIVE_CONTINUE_SOURCE_PROMPT,
            },
            {
              type: "fork",
              label: "fork-source",
            },
            {
              type: "turn",
              label: "fork-first-delta",
              prompt: THREAD_FORK_NATIVE_CONTINUE_FIRST_PROMPT,
            },
            {
              type: "turn",
              label: "fork-second-delta",
              prompt: THREAD_FORK_NATIVE_CONTINUE_SECOND_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "thread_fork_native_siblings",
      fileName: "thread_fork_native_siblings.ndjson",
      description:
        "One source marker turn and two independent native forks that each recall the source plus only their own fork marker.",
      runs: [
        {
          name: "native-sibling-forks",
          description:
            "Creates two native forks from the same source provider thread and proves their contexts remain isolated.",
          steps: [
            {
              type: "turn",
              label: "source",
              prompt: THREAD_FORK_NATIVE_SIBLINGS_SOURCE_PROMPT,
              thread: "source",
            },
            {
              type: "fork",
              label: "fork-first",
              from: "source",
              as: "first",
            },
            {
              type: "turn",
              label: "first-recall",
              prompt: THREAD_FORK_NATIVE_SIBLINGS_FIRST_PROMPT,
              thread: "first",
            },
            {
              type: "fork",
              label: "fork-second",
              from: "source",
              as: "second",
            },
            {
              type: "turn",
              label: "second-recall",
              prompt: THREAD_FORK_NATIVE_SIBLINGS_SECOND_PROMPT,
              thread: "second",
            },
          ],
        },
      ],
    },
    {
      name: "thread_merge_back_continue",
      fileName: "thread_merge_back_continue.ndjson",
      description:
        "A source thread consumes one fork-delta handoff and later recalls source and transferred context.",
      runs: [
        {
          name: "merge-native-fork",
          description:
            "Proves a merge-back handoff becomes durable context on the original provider thread.",
          steps: [
            {
              type: "turn",
              label: "source",
              prompt: THREAD_MERGE_BACK_SOURCE_PROMPT,
              thread: "source",
            },
            {
              type: "fork",
              label: "fork",
              from: "source",
              as: "fork",
            },
            {
              type: "turn",
              label: "fork-delta",
              prompt: THREAD_MERGE_BACK_FORK_PROMPT,
              thread: "fork",
            },
            {
              type: "turn",
              label: "merge-back",
              prompt: THREAD_MERGE_BACK_HANDOFF_PROMPT,
              thread: "source",
            },
            {
              type: "turn",
              label: "source-recall",
              prompt: THREAD_MERGE_BACK_RECALL_PROMPT,
              thread: "source",
            },
          ],
        },
      ],
    },
    {
      name: "thread_merge_back_siblings",
      fileName: "thread_merge_back_siblings.ndjson",
      description:
        "Two sibling fork deltas are merged sequentially into one source provider thread and recalled together.",
      runs: [
        {
          name: "merge-native-sibling-forks",
          description:
            "Proves repeated merge-back handoffs accumulate on the source while native sibling forks remain independent.",
          steps: [
            {
              type: "turn",
              label: "source",
              prompt: THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT,
              thread: "source",
            },
            {
              type: "fork",
              label: "fork-first",
              from: "source",
              as: "first",
            },
            {
              type: "turn",
              label: "first-fork-delta",
              prompt: THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
              thread: "first",
            },
            {
              type: "fork",
              label: "fork-second",
              from: "source",
              as: "second",
            },
            {
              type: "turn",
              label: "second-fork-delta",
              prompt: THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
              thread: "second",
            },
            {
              type: "turn",
              label: "merge-first",
              prompt: THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT,
              thread: "source",
            },
            {
              type: "turn",
              label: "merge-second",
              prompt: THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT,
              thread: "source",
            },
            {
              type: "turn",
              label: "source-recall",
              prompt: THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT,
              thread: "source",
            },
          ],
        },
      ],
    },
  ];
}

function makeRecorder({
  outPath,
  scenario,
}: {
  readonly outPath: string;
  readonly scenario: ReplayScenario;
}): Effect.Effect<Recorder, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
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
      const outputRecords = sessionizeForkReplayRecords({
        scenario: scenario.name,
        records,
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
}

function sessionizeForkReplayRecords(input: {
  readonly scenario: ScenarioName;
  readonly records: ReadonlyArray<Record<string, unknown>>;
}): ReadonlyArray<Record<string, unknown>> {
  if (
    input.scenario !== "thread_merge_back_continue" &&
    input.scenario !== "thread_merge_back_siblings"
  ) {
    return input.records;
  }
  const initializeRequest = input.records.find(
    (record) => record.type === "expect_outbound" && record.label === "initialize",
  );
  const initializeResponse = input.records.find(
    (record) => record.type === "emit_inbound" && record.label === "initialize",
  );
  const initializedNotification = input.records.find(
    (record) => record.type === "expect_outbound" && record.label === "initialized",
  );
  if (
    initializeRequest === undefined ||
    initializeResponse === undefined ||
    initializedNotification === undefined
  ) {
    throw new Error(`Scenario ${input.scenario} is missing initialization records.`);
  }

  let nextRequestId = 1;
  let forkSessionOrdinal = 0;
  const requestIdMap = new Map<number, number>();
  const output: Array<Record<string, unknown>> = [];
  const appendRequest = (record: Record<string, unknown>, id: number) => {
    const frame = record.frame as Record<string, unknown>;
    output.push({ ...record, frame: { ...frame, id } });
  };
  const appendResponse = (record: Record<string, unknown>, id: number) => {
    const frame = record.frame as Record<string, unknown>;
    output.push({ ...record, frame: { ...frame, id } });
  };

  for (const record of input.records) {
    const frame = record.frame;
    if (record.type === "expect_outbound" && isRecord(frame) && frame.method === "thread/fork") {
      forkSessionOrdinal += 1;
      const initializeId = nextRequestId++;
      appendRequest(
        { ...initializeRequest, label: `initialize/fork:${forkSessionOrdinal}` },
        initializeId,
      );
      appendResponse(
        { ...initializeResponse, label: `initialize/fork:${forkSessionOrdinal}` },
        initializeId,
      );
      output.push({
        ...initializedNotification,
        label: `initialized/fork:${forkSessionOrdinal}`,
      });
    }

    if (
      record.type === "expect_outbound" &&
      isRecord(frame) &&
      typeof frame.id === "number" &&
      typeof frame.method === "string"
    ) {
      const requestId = nextRequestId++;
      requestIdMap.set(frame.id, requestId);
      appendRequest(record, requestId);
      continue;
    }
    if (
      record.type === "emit_inbound" &&
      isRecord(frame) &&
      typeof frame.id === "number" &&
      !("method" in frame)
    ) {
      const responseId = requestIdMap.get(frame.id);
      if (responseId === undefined) {
        throw new Error(
          `Scenario ${input.scenario} has an unmatched response id ${String(frame.id)}.`,
        );
      }
      appendResponse(record, responseId);
      continue;
    }
    output.push(record);
  }
  return output;
}

function makeCodexLayer({ recorder }: { readonly recorder: Recorder }) {
  const clientRequestMethodById = new Map<string, string>();
  const serverRequestMethodById = new Map<string, string>();
  const clientOptions: CodexClient.CodexAppServerClientOptions = {
    logIncoming: true,
    logOutgoing: true,
    logger: (event) => {
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
    },
  };

  return Layer.effect(
    CodexClient.CodexAppServerClient,
    Effect.gen(function* () {
      const environment = yield* HostProcessEnvironment;
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

function installReplayHandlers({
  client,
  startTurn,
  completeTurn,
  startCommandExecution,
  beforeApprovalResponse,
}: {
  readonly client: CodexClient.CodexAppServerClientShape;
  readonly startTurn: (turnId: string) => Effect.Effect<void>;
  readonly completeTurn: (turnId: string) => Effect.Effect<void>;
  readonly startCommandExecution: (turnId: string) => Effect.Effect<void>;
  readonly beforeApprovalResponse: () => Effect.Effect<void>;
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
      client.handleServerNotification("item/completed", (payload) =>
        isRecord(payload.item) && payload.item.type === "commandExecution"
          ? startCommandExecution(payload.turnId).pipe(Effect.ignore)
          : Effect.void,
      ),
      client.handleServerNotification("item/started", (payload) =>
        isRecord(payload.item) && payload.item.type === "commandExecution"
          ? startCommandExecution(payload.turnId).pipe(Effect.ignore)
          : Effect.void,
      ),
    ],
    { discard: true },
  );
}

function runReplaySession({
  scenario,
  run,
  recorder,
}: {
  readonly scenario: ReplayScenario;
  readonly run: ReplayRun;
  readonly recorder: Recorder;
}) {
  return Effect.gen(function* () {
    const startedTurns = new Map<string, Deferred.Deferred<void>>();
    const completedTurns = new Map<string, Deferred.Deferred<void>>();
    const startedCommandExecutions = new Map<string, Deferred.Deferred<void>>();
    let approvalGate: Deferred.Deferred<void> | undefined;
    const getStarted = (turnId: string) => {
      const existing = startedTurns.get(turnId);
      if (existing) {
        return Effect.succeed(existing);
      }
      return Deferred.make<void>().pipe(
        Effect.tap((deferred) => Effect.sync(() => startedTurns.set(turnId, deferred))),
      );
    };
    const getCompletion = (turnId: string) => {
      const existing = completedTurns.get(turnId);
      if (existing) {
        return Effect.succeed(existing);
      }
      return Deferred.make<void>().pipe(
        Effect.tap((deferred) => Effect.sync(() => completedTurns.set(turnId, deferred))),
      );
    };
    const getCommandExecutionStarted = (turnId: string) => {
      const existing = startedCommandExecutions.get(turnId);
      if (existing) {
        return Effect.succeed(existing);
      }
      return Deferred.make<void>().pipe(
        Effect.tap((deferred) => Effect.sync(() => startedCommandExecutions.set(turnId, deferred))),
      );
    };
    const startTurn = (turnId: string) =>
      getStarted(turnId).pipe(Effect.flatMap((deferred) => Deferred.succeed(deferred, void 0)));
    const completeTurn = (turnId: string) =>
      getCompletion(turnId).pipe(Effect.flatMap((deferred) => Deferred.succeed(deferred, void 0)));
    const startCommandExecution = (turnId: string) =>
      getCommandExecutionStarted(turnId).pipe(
        Effect.flatMap((deferred) => Deferred.succeed(deferred, void 0)),
      );
    const beforeApprovalResponse = () =>
      approvalGate ? Deferred.await(approvalGate) : Effect.void;

    const initializeClient = Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;

      yield* installReplayHandlers({
        client,
        startTurn,
        completeTurn,
        startCommandExecution,
        beforeApprovalResponse,
      });

      yield* client.request("initialize", {
        clientInfo: CODEX_CLIENT_INFO,
        capabilities: CODEX_CLIENT_CAPABILITIES,
      });

      yield* client.notify("initialized", undefined);

      return client;
    });

    const runTurnStep = (
      client: CodexClient.CodexAppServerClientShape,
      threadId: string,
      step: TurnReplayStep,
    ) =>
      Effect.gen(function* () {
        const turnParams: TurnStartParams = {
          ...run.turnDefaults,
          ...step.turnOverrides,
          input: turnInput(step.prompt),
          threadId,
        };

        if (step.type === "steeredTurn") {
          approvalGate = yield* Deferred.make<void>();
        }

        const turn = yield* client.request("turn/start", turnParams);
        const turnId = getTurnId(turn);
        const started = yield* getStarted(turnId);
        yield* getCompletion(turnId);

        if (step.type === "steeredTurn") {
          yield* Deferred.await(started);
          yield* client.request("turn/steer", {
            expectedTurnId: turnId,
            input: turnInput(step.steer),
            threadId,
          });
          if (approvalGate) {
            yield* Deferred.succeed(approvalGate, void 0);
            approvalGate = undefined;
          }
        }

        if (step.type === "interruptedTurn") {
          if (step.interruptAfterCommandExecutionStarted === true) {
            const commandExecutionStarted = yield* getCommandExecutionStarted(turnId);
            yield* Deferred.await(commandExecutionStarted);
          } else {
            yield* Effect.sleep(`${step.interruptAfterMs ?? 1_500} millis`);
          }
          yield* client.request("turn/interrupt", {
            threadId,
            turnId,
          });
        }

        const completed = yield* getCompletion(turnId);
        yield* Deferred.await(completed);
      });

    if (scenario.name === "provider_thread_resume") {
      const firstStep = run.steps[0];
      const secondStep = run.steps[1];
      if (
        !firstStep ||
        !secondStep ||
        firstStep.type === "rollback" ||
        firstStep.type === "fork" ||
        secondStep.type === "rollback" ||
        secondStep.type === "fork"
      ) {
        throw new Error("provider_thread_resume replay recording requires two turn steps.");
      }

      const firstThread = yield* Effect.gen(function* () {
        const client = yield* initializeClient;
        const thread = yield* client.request("thread/start", {});
        yield* runTurnStep(client, thread.thread.id, firstStep);
        return thread;
      }).pipe(
        Effect.provide(
          makeCodexLayer({
            recorder,
          }),
        ),
      );

      yield* recorder.writeRecord({
        type: "runtime_exit",
        status: "success",
      });

      yield* Effect.gen(function* () {
        const client = yield* initializeClient;
        const thread = yield* client.request("thread/resume", {
          threadId: firstThread.thread.id,
        });
        yield* runTurnStep(client, thread.thread.id, secondStep);
      }).pipe(
        Effect.provide(
          makeCodexLayer({
            recorder,
          }),
        ),
      );
      return;
    }

    yield* Effect.gen(function* () {
      const client = yield* initializeClient;
      const thread = yield* client.request("thread/start", {});
      let activeThreadId = thread.thread.id;
      const threadIds = new Map<string, string>([["source", thread.thread.id]]);

      for (const [stepIndex, step] of run.steps.entries()) {
        if (step.type === "rollback") {
          yield* client.request("thread/rollback", {
            threadId: activeThreadId,
            numTurns: step.numTurns,
          });
          continue;
        }
        if (step.type === "fork") {
          const sourceThreadId =
            step.from === undefined ? activeThreadId : threadIds.get(step.from);
          if (sourceThreadId === undefined) {
            throw new Error(`Unknown replay thread alias '${step.from}'.`);
          }
          const forked = yield* client.request("thread/fork", {
            threadId: sourceThreadId,
          });
          activeThreadId = forked.thread.id;
          if (step.as !== undefined) {
            threadIds.set(step.as, forked.thread.id);
          }
          continue;
        }

        const threadAlias = "thread" in step ? step.thread : undefined;
        const turnThreadId =
          threadAlias === undefined ? activeThreadId : threadIds.get(threadAlias);
        if (turnThreadId === undefined) {
          throw new Error(`Unknown replay thread alias '${threadAlias}'.`);
        }
        yield* runTurnStep(client, turnThreadId, step);
        void stepIndex;
      }
    }).pipe(
      Effect.provide(
        makeCodexLayer({
          recorder,
        }),
      ),
    );
  });
}

function runScenario({
  scenario,
  outPath,
}: {
  readonly scenario: ReplayScenario;
  readonly outPath: string;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const recorder = yield* makeRecorder({ outPath, scenario });

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
}

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
      runScenario({
        scenario,
        outPath:
          singleOutPath ??
          (outDir ? path.join(outDir, scenario.fileName) : defaultTranscriptPath(scenario)),
      }),
    { concurrency: 1 },
  );
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
