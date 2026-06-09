import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import {
  recordClaudeAgentSdkReplayTranscript,
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
} from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { claudeRuntimeQueryPolicyForRuntimePolicy } from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2RuntimePolicy as ProviderAdapterV2RuntimePolicyType,
} from "../src/orchestration-v2/ProviderAdapter.ts";
import type { RuntimePolicyV2Override } from "../src/orchestration-v2/RuntimePolicy.ts";
import { makeCheckpointWorkspace } from "../src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { CLAUDE_MODEL_SELECTION } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import {
  MESSAGE_STEERING_INITIAL_PROMPT,
  MULTI_TURN_FIRST_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  READ_ONLY_NEVER_POLICY,
  READ_ONLY_ON_REQUEST_POLICY,
  RESTRICTED_GRANULAR_POLICY,
  MULTI_TURN_SECOND_PROMPT,
  SIMPLE_PROMPT,
  SUBAGENT_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_FIRST_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_SECOND_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_SIBLINGS_FIRST_PROMPT,
  THREAD_FORK_NATIVE_SIBLINGS_SECOND_PROMPT,
  THREAD_FORK_NATIVE_SIBLINGS_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_TARGET_PROMPT,
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
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  TOOL_CALL_READ_ONLY_PROMPT,
  TOOL_CALL_READ_ONLY_WORKSPACE_ROOT,
  TOOL_CALL_WRITE_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  TURN_INTERRUPT_PROMPT,
  TURN_INTERRUPT_RECOVERY_PROMPT,
  WORKSPACE_NEVER_POLICY,
  WEB_SEARCH_PROMPT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";

const CLAUDE_RECORDINGS = {
  simple: {
    prompts: [SIMPLE_PROMPT],
    defaultTranscriptFile: "fixtures/simple/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
  },
  multi_turn: {
    prompts: [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT],
    defaultTranscriptFile: "fixtures/multi_turn/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
  },
  multi_turn_restart: {
    prompts: [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT],
    defaultTranscriptFile: "fixtures/multi_turn_restart/claude_transcript.ndjson",
    queryMode: "restart",
    enableTools: true,
  },
  queued_turn: {
    prompts: [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT],
    defaultTranscriptFile: "fixtures/queued_turn/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
  },
  message_steering: {
    prompts: [MESSAGE_STEERING_INITIAL_PROMPT, MESSAGE_STEERING_STEER_PROMPT],
    defaultTranscriptFile: "fixtures/message_steering/claude_transcript.ndjson",
    queryMode: "active_steering",
    enableTools: true,
  },
  turn_interrupt_mid_tool: {
    prompts: [TURN_INTERRUPT_MID_TOOL_PROMPT],
    defaultTranscriptFile: "fixtures/turn_interrupt_mid_tool/claude_transcript.ndjson",
    queryMode: "interrupt",
    enableTools: true,
    interruptAfter: "tool_use",
  },
  turn_interrupt: {
    prompts: [TURN_INTERRUPT_PROMPT],
    defaultTranscriptFile: "fixtures/turn_interrupt/claude_transcript.ndjson",
    queryMode: "interrupt",
    enableTools: true,
  },
  turn_interrupt_restart: {
    prompts: [TURN_INTERRUPT_MID_TOOL_PROMPT, TURN_INTERRUPT_RECOVERY_PROMPT],
    defaultTranscriptFile: "fixtures/turn_interrupt_restart/claude_transcript.ndjson",
    queryMode: "interrupt_restart",
    enableTools: true,
    interruptAfter: "tool_use",
  },
  tool_call_read_only: {
    prompts: [TOOL_CALL_READ_ONLY_PROMPT],
    defaultTranscriptFile: "fixtures/tool_call_read_only/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
  },
  tool_call_read_only_on_request: {
    prompts: [TOOL_CALL_WRITE_PROMPT],
    defaultTranscriptFile: "fixtures/tool_call_read_only_on_request/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
  },
  tool_call_workspace_never: {
    prompts: [TOOL_CALL_WRITE_PROMPT],
    defaultTranscriptFile: "fixtures/tool_call_workspace_never/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
  },
  tool_call_restricted_granular: {
    prompts: [TOOL_CALL_WRITE_PROMPT],
    defaultTranscriptFile: "fixtures/tool_call_restricted_granular/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
  },
  web_search: {
    prompts: [WEB_SEARCH_PROMPT],
    defaultTranscriptFile: "fixtures/web_search/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
  },
  subagent: {
    prompts: [SUBAGENT_PROMPT],
    defaultTranscriptFile: "fixtures/subagent/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
  },
  thread_rollback: {
    prompts: [
      THREAD_ROLLBACK_FIRST_PROMPT,
      THREAD_ROLLBACK_SECOND_PROMPT,
      THREAD_ROLLBACK_AFTER_PROMPT,
    ],
    defaultTranscriptFile: "fixtures/thread_rollback/claude_transcript.ndjson",
    queryMode: "resume_at_cursor",
    enableTools: true,
  },
  thread_fork_native: {
    prompts: [THREAD_FORK_NATIVE_SOURCE_PROMPT, THREAD_FORK_NATIVE_TARGET_PROMPT],
    defaultTranscriptFile: "fixtures/thread_fork_native/claude_transcript.ndjson",
    queryMode: "fork_session",
    enableTools: true,
  },
  thread_fork_native_prior_turn: {
    prompts: [
      THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
      THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT,
      THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
    ],
    defaultTranscriptFile: "fixtures/thread_fork_native_prior_turn/claude_transcript.ndjson",
    queryMode: "fork_session_prior_turn",
    enableTools: true,
  },
  thread_fork_native_continue: {
    prompts: [
      THREAD_FORK_NATIVE_CONTINUE_SOURCE_PROMPT,
      THREAD_FORK_NATIVE_CONTINUE_FIRST_PROMPT,
      THREAD_FORK_NATIVE_CONTINUE_SECOND_PROMPT,
    ],
    defaultTranscriptFile: "fixtures/thread_fork_native_continue/claude_transcript.ndjson",
    queryMode: "fork_session_continue",
    enableTools: true,
  },
  thread_fork_native_siblings: {
    prompts: [
      THREAD_FORK_NATIVE_SIBLINGS_SOURCE_PROMPT,
      THREAD_FORK_NATIVE_SIBLINGS_FIRST_PROMPT,
      THREAD_FORK_NATIVE_SIBLINGS_SECOND_PROMPT,
    ],
    defaultTranscriptFile: "fixtures/thread_fork_native_siblings/claude_transcript.ndjson",
    queryMode: "fork_session_siblings",
    enableTools: true,
  },
  thread_merge_back_continue: {
    prompts: [
      THREAD_MERGE_BACK_SOURCE_PROMPT,
      THREAD_MERGE_BACK_FORK_PROMPT,
      THREAD_MERGE_BACK_HANDOFF_PROMPT,
      THREAD_MERGE_BACK_RECALL_PROMPT,
    ],
    defaultTranscriptFile: "fixtures/thread_merge_back_continue/claude_transcript.ndjson",
    queryMode: "fork_session_merge_back",
    enableTools: true,
  },
  thread_merge_back_siblings: {
    prompts: [
      THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT,
      THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
      THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
      THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT,
      THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT,
      THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT,
    ],
    defaultTranscriptFile: "fixtures/thread_merge_back_siblings/claude_transcript.ndjson",
    queryMode: "fork_session_merge_back_siblings",
    enableTools: true,
  },
} as const;

function readArgValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

type ClaudeRecordingQueryMode =
  | "streaming"
  | "restart"
  | "resume_at_cursor"
  | "fork_session"
  | "fork_session_prior_turn"
  | "fork_session_continue"
  | "fork_session_siblings"
  | "fork_session_merge_back"
  | "fork_session_merge_back_siblings"
  | "active_steering"
  | "interrupt"
  | "interrupt_restart";

function selectedQueryMode(defaultMode: ClaudeRecordingQueryMode): ClaudeRecordingQueryMode {
  const raw = readArgValue("--query-mode") ?? process.env.T3_CLAUDE_REPLAY_QUERY_MODE;
  if (raw === undefined) {
    return defaultMode;
  }
  if (
    raw === "streaming" ||
    raw === "restart" ||
    raw === "resume_at_cursor" ||
    raw === "fork_session" ||
    raw === "fork_session_prior_turn" ||
    raw === "fork_session_continue" ||
    raw === "fork_session_siblings" ||
    raw === "fork_session_merge_back" ||
    raw === "fork_session_merge_back_siblings" ||
    raw === "active_steering" ||
    raw === "interrupt" ||
    raw === "interrupt_restart"
  ) {
    return raw;
  }
  throw new Error(
    `Unsupported Claude replay query mode '${raw}'. Use 'streaming', 'restart', 'resume_at_cursor', 'fork_session', 'fork_session_prior_turn', 'fork_session_continue', 'fork_session_siblings', 'fork_session_merge_back', 'fork_session_merge_back_siblings', 'active_steering', 'interrupt', or 'interrupt_restart'.`,
  );
}

const scenario = readArgValue("--scenario") ?? process.env.T3_CLAUDE_REPLAY_SCENARIO ?? "simple";
const recording = CLAUDE_RECORDINGS[scenario as keyof typeof CLAUDE_RECORDINGS];
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

if (recording === undefined) {
  throw new Error(
    `Claude replay fixture '${scenario}' is not configured. ` +
      "TODO: approval fixtures need permission callback recording before they can be generated.",
  );
}

const positionalOutputPath = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
const outputPath =
  readArgValue("--out") ??
  positionalOutputPath ??
  new URL(`../src/orchestration-v2/testkit/${recording.defaultTranscriptFile}`, import.meta.url)
    .pathname;

function encodeTranscriptNdjson(
  transcript: Awaited<ReturnType<typeof recordClaudeAgentSdkReplayTranscript>>,
): string {
  const { entries, ...metadata } = transcript;
  return [
    JSON.stringify({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => JSON.stringify(entry)),
    "",
  ].join("\n");
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\/+$/u, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) {
    return ".";
  }
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}

function joinPath(directory: string, fileName: string): string {
  return `${directory.replace(/\/+$/u, "")}/${fileName.replace(/^\/+/u, "")}`;
}

function runFileSystem<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
}

function selectedPrompts(): ReadonlyArray<string> {
  if (process.env.T3_CLAUDE_REPLAY_PROMPTS !== undefined) {
    return process.env.T3_CLAUDE_REPLAY_PROMPTS.split("\n---\n").filter(
      (prompt) => prompt.length > 0,
    );
  }
  if (process.env.T3_CLAUDE_REPLAY_PROMPT !== undefined) {
    return [process.env.T3_CLAUDE_REPLAY_PROMPT];
  }
  return recording.prompts;
}

function runtimePolicyForRecording(input: {
  readonly cwd: string;
  readonly override?: RuntimePolicyV2Override;
}): ProviderAdapterV2RuntimePolicyType {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: input.override?.cwd ?? input.cwd,
    ...(input.override?.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: input.override.approvalPolicy }),
    ...(input.override?.sandboxPolicy === undefined
      ? {}
      : { sandboxPolicy: input.override.sandboxPolicy }),
    ...(input.override?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: input.override.reasoningEffort }),
  });
}

async function makeToolCallReadOnlyRecordingWorkspace(): Promise<string> {
  await runFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, { recursive: true, force: true });
      yield* fs.makeDirectory(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, { recursive: true });
    }),
  );
  return TOOL_CALL_READ_ONLY_WORKSPACE_ROOT;
}

const cwd =
  process.env.T3_CLAUDE_REPLAY_CWD ??
  (scenario === "tool_call_read_only"
    ? await makeToolCallReadOnlyRecordingWorkspace()
    : await makeCheckpointWorkspace(`claude-agent-sdk-record-${scenario}`));
const shouldRemoveCwd = process.env.T3_CLAUDE_REPLAY_CWD === undefined;

if (shouldRemoveCwd && (scenario === "tool_call_read_only" || scenario === "subagent")) {
  await runFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        joinPath(cwd, "package.json"),
        encodeUnknownJsonString({
          name: "claude-read-only-fixture",
          private: true,
          scripts: { typecheck: "tsc --noEmit" },
        }),
      );
      yield* fs.writeFileString(
        joinPath(cwd, "tsconfig.json"),
        encodeUnknownJsonString({
          compilerOptions: {
            module: "ESNext",
            strict: true,
            target: "ES2022",
          },
        }),
      );
    }),
  );
}

try {
  const runtimePolicy = runtimePolicyForRecording({
    cwd,
    ...("runtimePolicyOverride" in recording ? { override: recording.runtimePolicyOverride } : {}),
  });
  const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy);

  const transcript = await recordClaudeAgentSdkReplayTranscript({
    scenario,
    prompts: selectedPrompts(),
    modelSelection: {
      ...CLAUDE_MODEL_SELECTION,
      model: process.env.T3_CLAUDE_REPLAY_MODEL ?? CLAUDE_MODEL_SELECTION.model,
    },
    cwd,
    ...(process.env.T3_CLAUDE_REPLAY_SESSION_ID === undefined
      ? {}
      : { sessionId: process.env.T3_CLAUDE_REPLAY_SESSION_ID }),
    queryMode: selectedQueryMode(recording.queryMode),
    ...("enableTools" in recording && recording.enableTools === true ? { enableTools: true } : {}),
    ...(queryPolicy.tools === undefined ? {} : { tools: queryPolicy.tools }),
    permissionMode: queryPolicy.permissionMode,
    ...(queryPolicy.allowedTools === undefined ? {} : { allowedTools: queryPolicy.allowedTools }),
    ...(queryPolicy.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: queryPolicy.allowDangerouslySkipPermissions }),
    ...(queryPolicy.installPermissionCallback ? { enablePermissionCallback: true } : {}),
    ...("interruptAfter" in recording ? { interruptAfter: recording.interruptAfter } : {}),
  });
  await runFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dirname(outputPath), { recursive: true });
      yield* fs.writeFileString(outputPath, encodeTranscriptNdjson(transcript));
    }),
  );
  await Effect.runPromise(
    Console.log(
      `Wrote ${transcript.entries.length} ${CLAUDE_AGENT_SDK_REPLAY_PROTOCOL} replay entries to ${outputPath}`,
    ),
  );
} finally {
  if (shouldRemoveCwd) {
    await runFileSystem(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(cwd, { recursive: true, force: true });
      }),
    );
  }
}
