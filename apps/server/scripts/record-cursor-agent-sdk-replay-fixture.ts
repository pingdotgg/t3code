import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Command, Flag } from "effect/unstable/cli";

import {
  recordCursorAgentSdkReplayTranscript,
  type CursorAgentSdkReplayTranscript,
} from "../src/orchestration-v2/Adapters/CursorAdapterV2.testkit.ts";
import { checkpointWorkspace } from "../src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import {
  CURSOR_MODEL_SELECTION,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  PROPOSED_PLAN_PROMPT,
  READ_ONLY_NEVER_POLICY,
  SIMPLE_PROMPT,
  SKILL_INVOCATION_CURSOR_MESSAGE,
  SUBAGENT_PROMPT,
  TODO_LIST_PROMPT,
  TOOL_CALL_READ_ONLY_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  WORKSPACE_NEVER_POLICY,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { skillInvocationInput } from "../src/orchestration-v2/testkit/fixtures/skill_invocation/input.ts";
import {
  cursorReplayPromptsForWorkspace,
  cursorReplayTranscriptCwd,
  shouldSeedCursorReplayWorkspace,
} from "./cursorReplayRecordingWorkspace.ts";

const RECORDINGS = {
  simple: {
    prompts: [SIMPLE_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/simple/cursor_transcript.ndjson",
  },
  multi_turn: {
    prompts: [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/multi_turn/cursor_transcript.ndjson",
  },
  message_steering: {
    prompts: [MESSAGE_STEERING_INITIAL_PROMPT, MESSAGE_STEERING_STEER_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/message_steering/cursor_transcript.ndjson",
    interruptAfterRunStartPromptIndex: 0,
  },
  provider_thread_resume: {
    prompts: [PROVIDER_THREAD_RESUME_FIRST_PROMPT, PROVIDER_THREAD_RESUME_SECOND_PROMPT],
    output:
      "../src/orchestration-v2/testkit/fixtures/provider_thread_resume/cursor_transcript.ndjson",
    restartBeforePromptIndex: 1,
  },
  queued_turn: {
    prompts: [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/queued_turn/cursor_transcript.ndjson",
  },
  proposed_plan: {
    prompts: [PROPOSED_PLAN_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/proposed_plan/cursor_transcript.ndjson",
    interactionMode: "plan",
    runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
  },
  todo_list: {
    prompts: [TODO_LIST_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/todo_list/cursor_transcript.ndjson",
    runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
  },
  subagent: {
    prompts: [SUBAGENT_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/subagent/cursor_transcript.ndjson",
    runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
  },
  tool_call_read_only: {
    prompts: [TOOL_CALL_READ_ONLY_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/tool_call_read_only/cursor_transcript.ndjson",
    runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
  },
  turn_interrupt_mid_tool: {
    prompts: [TURN_INTERRUPT_MID_TOOL_PROMPT],
    output:
      "../src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/cursor_transcript.ndjson",
    interruptAfterToolStart: true,
    runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
  },
  skill_invocation: {
    // The adapter rewrites a discovered `$review` mention to Cursor's native
    // `/review` invocation before sending, so the SDK sees the rewritten form.
    prompts: [SKILL_INVOCATION_CURSOR_MESSAGE],
    output: "../src/orchestration-v2/testkit/fixtures/skill_invocation/cursor_transcript.ndjson",
    workspaceFiles: skillInvocationInput().workspaceFiles,
  },
} as const;

type RecordingName = keyof typeof RECORDINGS;
const RECORDING_NAMES = Struct.keys(RECORDINGS);

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function encodeTranscriptNdjson(transcript: CursorAgentSdkReplayTranscript): string {
  const { entries, ...metadata } = transcript;
  return [
    encodeUnknownJsonString({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => encodeUnknownJsonString(entry)),
    "",
  ].join("\n");
}

const writeFixtureFiles = Effect.fn("writeFixtureFiles")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(cwd, "package.json"),
    encodeUnknownJsonString({
      name: "cursor-read-only-fixture",
      private: true,
      scripts: { typecheck: "tsc --noEmit" },
    }),
  );
  yield* fs.writeFileString(
    path.join(cwd, "tsconfig.json"),
    encodeUnknownJsonString({
      compilerOptions: {
        module: "ESNext",
        strict: true,
        target: "ES2022",
      },
    }),
  );
});

const recordScenario = Effect.fn("recordScenario")(function* (
  scenario: RecordingName,
  out: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const apiKey = yield* Config.Redacted("CURSOR_API_KEY");
  const model = yield* Config.NonEmptyString("T3_CURSOR_REPLAY_MODEL").pipe(
    Config.withDefault(CURSOR_MODEL_SELECTION.model),
  );
  const configuredCwd = yield* Config.NonEmptyString("T3_CURSOR_REPLAY_CWD").pipe(Config.option);
  const recording = RECORDINGS[scenario];

  const owned = Option.isNone(configuredCwd);
  const cwd = Option.isSome(configuredCwd)
    ? configuredCwd.value
    : yield* checkpointWorkspace(
        `cursor-agent-sdk-record-${scenario}`,
        "workspaceFiles" in recording ? recording.workspaceFiles : undefined,
      );
  if (shouldSeedCursorReplayWorkspace({ scenario, owned })) {
    yield* writeFixtureFiles(cwd);
  }
  const transcriptCwd = cursorReplayTranscriptCwd(scenario);
  const transcript = yield* recordCursorAgentSdkReplayTranscript({
    scenario,
    prompts: cursorReplayPromptsForWorkspace({
      scenario,
      configuredPrompts: recording.prompts,
      packageJsonPath: path.join(cwd, "package.json"),
      tsconfigPath: path.join(cwd, "tsconfig.json"),
    }),
    ...(scenario === "tool_call_read_only" ? { transcriptPrompts: recording.prompts } : {}),
    modelSelection: { ...CURSOR_MODEL_SELECTION, model },
    cwd,
    ...(transcriptCwd === undefined ? {} : { transcriptCwd }),
    apiKey: Redacted.value(apiKey),
    ...("interactionMode" in recording ? { interactionMode: recording.interactionMode } : {}),
    ...("runtimePolicyOverride" in recording
      ? { runtimePolicyOverride: recording.runtimePolicyOverride }
      : {}),
    ...("interruptAfterToolStart" in recording
      ? { interruptAfterToolStart: recording.interruptAfterToolStart }
      : {}),
    ...("interruptAfterRunStartPromptIndex" in recording
      ? { interruptAfterRunStartPromptIndex: recording.interruptAfterRunStartPromptIndex }
      : {}),
    ...("restartBeforePromptIndex" in recording
      ? { restartBeforePromptIndex: recording.restartBeforePromptIndex }
      : {}),
  });

  const outputPath = out ?? (yield* path.fromFileUrl(new URL(recording.output, import.meta.url)));
  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* fs.writeFileString(outputPath, encodeTranscriptNdjson(transcript));
  yield* Console.log(
    `Wrote ${transcript.entries.length} Cursor SDK replay entries to ${outputPath}`,
  );
}, Effect.scoped);

const recordCursorReplayCommand = Command.make(
  "record-cursor-agent-sdk-replay-fixture",
  {
    scenario: Flag.Literals("scenario", RECORDING_NAMES).pipe(
      Flag.withDescription("Scenario to record (or T3_CURSOR_REPLAY_SCENARIO)."),
      Flag.withFallbackConfig(Config.Literals(RECORDING_NAMES, "T3_CURSOR_REPLAY_SCENARIO")),
    ),
    out: Flag.String("out").pipe(
      Flag.optional,
      Flag.withDescription("Write the transcript here instead of over the checked-in fixture."),
    ),
  },
  ({ scenario, out }) => recordScenario(scenario, Option.getOrUndefined(out)),
).pipe(
  Command.withDescription(
    "Record a Cursor Agent SDK replay fixture live. Reads CURSOR_API_KEY, plus optional T3_CURSOR_REPLAY_MODEL and T3_CURSOR_REPLAY_CWD.",
  ),
);

Command.run(recordCursorReplayCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
