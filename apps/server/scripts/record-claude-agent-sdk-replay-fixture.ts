import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  recordClaudeAgentSdkReplayTranscript,
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
} from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { makeCheckpointWorkspace } from "../src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { CLAUDE_MODEL_SELECTION } from "../src/orchestration-v2/testkit/fixtures/claude.ts";
import {
  SIMPLE_PROMPT,
  TOOL_CALL_READ_ONLY_PROMPT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";

const CLAUDE_SINGLE_QUERY_RECORDINGS = {
  simple: {
    prompt: SIMPLE_PROMPT,
    defaultTranscriptFile: "fixtures/simple/claude_transcript.ndjson",
  },
  tool_call_read_only: {
    prompt: TOOL_CALL_READ_ONLY_PROMPT,
    defaultTranscriptFile: "fixtures/tool_call_read_only/claude_transcript.ndjson",
  },
} as const;

function readArgValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const scenario = readArgValue("--scenario") ?? process.env.T3_CLAUDE_REPLAY_SCENARIO ?? "simple";
const recording =
  CLAUDE_SINGLE_QUERY_RECORDINGS[scenario as keyof typeof CLAUDE_SINGLE_QUERY_RECORDINGS];

if (recording === undefined) {
  throw new Error(
    `Claude replay fixture '${scenario}' is not a single-query recording yet. ` +
      "TODO: multi_turn needs multiple query() calls in one transcript; approval fixtures need permission callback recording.",
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

const cwd =
  process.env.T3_CLAUDE_REPLAY_CWD ??
  (await makeCheckpointWorkspace("claude-agent-sdk-record-simple"));
const shouldRemoveCwd = process.env.T3_CLAUDE_REPLAY_CWD === undefined;

try {
  const transcript = await recordClaudeAgentSdkReplayTranscript({
    scenario,
    prompt: process.env.T3_CLAUDE_REPLAY_PROMPT ?? recording.prompt,
    modelSelection: {
      ...CLAUDE_MODEL_SELECTION,
      model: process.env.T3_CLAUDE_REPLAY_MODEL ?? CLAUDE_MODEL_SELECTION.model,
    },
    cwd,
    ...(process.env.T3_CLAUDE_REPLAY_SESSION_ID === undefined
      ? {}
      : { sessionId: process.env.T3_CLAUDE_REPLAY_SESSION_ID }),
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, encodeTranscriptNdjson(transcript), "utf8");
  console.log(
    `Wrote ${transcript.entries.length} ${CLAUDE_AGENT_SDK_REPLAY_PROTOCOL} replay entries to ${outputPath}`,
  );
} finally {
  if (shouldRemoveCwd) {
    await rm(cwd, { recursive: true, force: true });
  }
}
