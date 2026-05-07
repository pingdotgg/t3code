import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  recordClaudeAgentSdkReplayTranscript,
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
} from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { makeCheckpointWorkspace } from "../src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { CLAUDE_MODEL_SELECTION } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import {
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  SIMPLE_PROMPT,
  TOOL_CALL_READ_ONLY_PROMPT,
  TOOL_CALL_WRITE_PROMPT,
  WEB_SEARCH_PROMPT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";

const CLAUDE_RECORDINGS = {
  simple: {
    prompts: [SIMPLE_PROMPT],
    defaultTranscriptFile: "fixtures/simple/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
  multi_turn: {
    prompts: [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT],
    defaultTranscriptFile: "fixtures/multi_turn/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
  multi_turn_restart: {
    prompts: [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT],
    defaultTranscriptFile: "fixtures/multi_turn_restart/claude_transcript.ndjson",
    queryMode: "restart",
    enableTools: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
  tool_call_read_only: {
    prompts: [TOOL_CALL_READ_ONLY_PROMPT],
    defaultTranscriptFile: "fixtures/tool_call_read_only/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    permissionMode: "default",
    enablePermissionCallback: true,
  },
  tool_call_read_only_on_request: {
    prompts: [TOOL_CALL_WRITE_PROMPT],
    defaultTranscriptFile: "fixtures/tool_call_read_only_on_request/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    permissionMode: "default",
    enablePermissionCallback: true,
  },
  tool_call_workspace_never: {
    prompts: [TOOL_CALL_WRITE_PROMPT],
    defaultTranscriptFile: "fixtures/tool_call_workspace_never/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
  tool_call_restricted_granular: {
    prompts: [TOOL_CALL_WRITE_PROMPT],
    defaultTranscriptFile: "fixtures/tool_call_restricted_granular/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    permissionMode: "default",
    enablePermissionCallback: true,
  },
  web_search: {
    prompts: [WEB_SEARCH_PROMPT],
    defaultTranscriptFile: "fixtures/web_search/claude_transcript.ndjson",
    queryMode: "streaming",
    enableTools: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
} as const;

function readArgValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function selectedQueryMode(defaultMode: "streaming" | "restart"): "streaming" | "restart" {
  const raw = readArgValue("--query-mode") ?? process.env.T3_CLAUDE_REPLAY_QUERY_MODE;
  if (raw === undefined) {
    return defaultMode;
  }
  if (raw === "streaming" || raw === "restart") {
    return raw;
  }
  throw new Error(`Unsupported Claude replay query mode '${raw}'. Use 'streaming' or 'restart'.`);
}

const scenario = readArgValue("--scenario") ?? process.env.T3_CLAUDE_REPLAY_SCENARIO ?? "simple";
const recording = CLAUDE_RECORDINGS[scenario as keyof typeof CLAUDE_RECORDINGS];

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

const cwd =
  process.env.T3_CLAUDE_REPLAY_CWD ??
  (await makeCheckpointWorkspace(`claude-agent-sdk-record-${scenario}`));
const shouldRemoveCwd = process.env.T3_CLAUDE_REPLAY_CWD === undefined;

try {
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
    ...("permissionMode" in recording ? { permissionMode: recording.permissionMode } : {}),
    ...("allowDangerouslySkipPermissions" in recording
      ? { allowDangerouslySkipPermissions: recording.allowDangerouslySkipPermissions }
      : {}),
    ...("enablePermissionCallback" in recording
      ? { enablePermissionCallback: recording.enablePermissionCallback }
      : {}),
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
