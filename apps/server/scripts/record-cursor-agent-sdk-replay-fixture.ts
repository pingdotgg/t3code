import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { recordCursorAgentSdkReplayTranscript } from "../src/orchestration-v2/Adapters/CursorAdapterV2.testkit.ts";
import { makeCheckpointWorkspace } from "../src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import {
  CURSOR_MODEL_SELECTION,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  PROPOSED_PLAN_PROMPT,
  SIMPLE_PROMPT,
  SUBAGENT_PROMPT,
  TODO_LIST_PROMPT,
  TOOL_CALL_READ_ONLY_PROMPT,
  TOOL_CALL_READ_ONLY_WORKSPACE_ROOT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";

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
  },
  todo_list: {
    prompts: [TODO_LIST_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/todo_list/cursor_transcript.ndjson",
  },
  subagent: {
    prompts: [SUBAGENT_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/subagent/cursor_transcript.ndjson",
  },
  tool_call_read_only: {
    prompts: [TOOL_CALL_READ_ONLY_PROMPT],
    output: "../src/orchestration-v2/testkit/fixtures/tool_call_read_only/cursor_transcript.ndjson",
  },
  turn_interrupt_mid_tool: {
    prompts: [TURN_INTERRUPT_MID_TOOL_PROMPT],
    output:
      "../src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/cursor_transcript.ndjson",
    interruptAfterToolStart: true,
  },
} as const;

type RecordingName = keyof typeof RECORDINGS;

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function encodeTranscriptNdjson(
  transcript: Awaited<ReturnType<typeof recordCursorAgentSdkReplayTranscript>>,
): string {
  const { entries, ...metadata } = transcript;
  return [
    encodeUnknownJsonString({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => encodeUnknownJsonString(entry)),
    "",
  ].join("\n");
}

const runFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

async function prepareWorkspace(scenario: RecordingName): Promise<{
  readonly cwd: string;
  readonly remove: boolean;
}> {
  if (process.env.T3_CURSOR_REPLAY_CWD !== undefined) {
    return {
      cwd: process.env.T3_CURSOR_REPLAY_CWD,
      remove: false,
    };
  }
  if (scenario === "tool_call_read_only") {
    await runFileSystem(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, {
          recursive: true,
          force: true,
        });
        yield* fs.makeDirectory(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, {
          recursive: true,
        });
      }),
    );
    return {
      cwd: TOOL_CALL_READ_ONLY_WORKSPACE_ROOT,
      remove: true,
    };
  }
  return {
    cwd: await makeCheckpointWorkspace(`cursor-agent-sdk-record-${scenario}`),
    remove: true,
  };
}

async function writeFixtureFiles(cwd: string): Promise<void> {
  await runFileSystem(
    Effect.gen(function* () {
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
    }),
  );
}

const scenario = (readArgValue("--scenario") ?? process.env.T3_CURSOR_REPLAY_SCENARIO) as
  | RecordingName
  | undefined;
if (scenario === undefined || RECORDINGS[scenario] === undefined) {
  throw new Error(`Pass --scenario with one of: ${Object.keys(RECORDINGS).join(", ")}`);
}

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  throw new Error("CURSOR_API_KEY is required to record Cursor SDK replay fixtures.");
}

const recording = RECORDINGS[scenario];
const workspace = await prepareWorkspace(scenario);
if (scenario === "subagent" || scenario === "tool_call_read_only" || scenario === "todo_list") {
  await writeFixtureFiles(workspace.cwd);
}

const outputPath = readArgValue("--out") ?? new URL(recording.output, import.meta.url).pathname;

try {
  const transcript = await recordCursorAgentSdkReplayTranscript({
    scenario,
    prompts: recording.prompts,
    modelSelection: {
      ...CURSOR_MODEL_SELECTION,
      model: process.env.T3_CURSOR_REPLAY_MODEL ?? CURSOR_MODEL_SELECTION.model,
    },
    cwd: workspace.cwd,
    apiKey,
    ...("interactionMode" in recording ? { interactionMode: recording.interactionMode } : {}),
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
  await runFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
      yield* fs.writeFileString(outputPath, encodeTranscriptNdjson(transcript));
    }),
  );
  await Effect.runPromise(
    Console.log(`Wrote ${transcript.entries.length} Cursor SDK replay entries to ${outputPath}`),
  );
} finally {
  if (workspace.remove) {
    await runFileSystem(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(workspace.cwd, { recursive: true, force: true });
      }),
    );
  }
}
