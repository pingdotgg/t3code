import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import {
  THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER,
  THREAD_FORK_NATIVE_CONTINUE_RECALL,
  THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER,
  THREAD_MERGE_BACK_FORK_MARKER,
  THREAD_MERGE_BACK_RECALL,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_RECALL,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER,
  THREAD_MERGE_BACK_SOURCE_MARKER,
} from "./fixtures/shared.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

const PROVIDER_THREAD_RESUME_FIRST_FINAL = "provider thread resume fixture first turn complete";
const PROVIDER_THREAD_RESUME_SECOND_FINAL = "provider thread resume fixture second turn complete";

type ProtocolReplayEntry = Extract<
  ProviderReplayTranscript["entries"][number],
  { readonly type: "expect_outbound" | "emit_inbound" }
>;

const CODEX_REPLAY_FIXTURES = ORCHESTRATOR_REPLAY_FIXTURES.flatMap((fixture) =>
  fixture.providers
    .filter((provider) => provider.driver === "codex")
    .map((provider) => ({
      scenario: fixture.name,
      transcriptFile: provider.transcriptFile,
    })),
).concat([
  {
    scenario: "provider_thread_resume",
    transcriptFile: new URL(
      "./fixtures/provider_thread_resume/codex_transcript.ndjson",
      import.meta.url,
    ),
  },
  {
    scenario: "thread_fork_native_continue",
    transcriptFile: new URL(
      "./fixtures/thread_fork_native_continue/codex_transcript.ndjson",
      import.meta.url,
    ),
  },
  {
    scenario: "thread_fork_native_siblings",
    transcriptFile: new URL(
      "./fixtures/thread_fork_native_siblings/codex_transcript.ndjson",
      import.meta.url,
    ),
  },
  {
    scenario: "thread_merge_back_continue",
    transcriptFile: new URL(
      "./fixtures/thread_merge_back_continue/codex_transcript.ndjson",
      import.meta.url,
    ),
  },
  {
    scenario: "thread_merge_back_siblings",
    transcriptFile: new URL(
      "./fixtures/thread_merge_back_siblings/codex_transcript.ndjson",
      import.meta.url,
    ),
  },
]);

const scenarioExpectations = {
  simple: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["thread/started", "turn/started", "turn/completed"],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 0,
  },
  tool_call_read_only_on_request: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["item/commandExecution/requestApproval", "serverRequest/resolved", "turn/completed"],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 1,
  },
  tool_call_workspace_never: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["turn/completed"],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 0,
  },
  tool_call_restricted_granular: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: [
      "item/fileChange/requestApproval",
      "serverRequest/resolved",
      "item/fileChange/outputDelta",
      "turn/diff/updated",
      "turn/completed",
    ],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 1,
  },
  subagent: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 1,
    turnCompletedCount: 3,
    approvalRequestCount: 0,
  },
  subagent_continue: {
    outgoing: [
      "initialize",
      "initialized",
      "thread/start",
      "turn/start/spawn",
      "turn/start/continue",
    ],
    incoming: [
      "turn/started/root-1",
      "turn/completed/child-1",
      "turn/completed/root-1",
      "turn/started/root-2",
      "turn/completed/child-2",
      "turn/completed/root-2",
    ],
    turnStartCount: 0,
    turnCompletedCount: 0,
    approvalRequestCount: 0,
  },
  subagent_v2: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: [
      "turn/started",
      "item/completed/subAgentActivity-started",
      "turn/started/child",
      "item/completed/child-answer",
      "turn/completed",
    ],
    turnStartCount: 1,
    turnCompletedCount: 2,
    approvalRequestCount: 0,
  },
  multi_turn: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 2,
    turnCompletedCount: 2,
    approvalRequestCount: 0,
  },
  plan_questions: {
    outgoing: [
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "item/tool/requestUserInput",
    ],
    incoming: [
      "turn/started",
      "turn/completed",
      "item/tool/requestUserInput",
      "serverRequest/resolved",
      "item/agentMessage/delta",
    ],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 0,
  },
  proposed_plan: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 0,
  },
  provider_thread_resume: {
    outgoing: ["initialize", "initialized", "thread/start", "thread/resume", "turn/start"],
    incoming: ["thread/started", "turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 2,
    turnCompletedCount: 2,
    approvalRequestCount: 0,
  },
  queued_turn: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 2,
    turnCompletedCount: 2,
    approvalRequestCount: 0,
  },
  message_steering: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start", "turn/steer"],
    incoming: ["turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 0,
  },
  turn_interrupt: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt"],
    incoming: ["turn/started", "turn/completed"],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 0,
  },
  turn_interrupt_mid_tool: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt"],
    incoming: ["turn/started", "item/started", "turn/completed"],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 0,
  },
  thread_rollback: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start", "thread/rollback"],
    incoming: ["turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 3,
    turnCompletedCount: 3,
    approvalRequestCount: 0,
  },
  thread_fork_native_continue: {
    outgoing: ["initialize", "initialized", "thread/start", "thread/fork", "turn/start"],
    incoming: ["thread/started", "turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 3,
    turnCompletedCount: 3,
    approvalRequestCount: 0,
  },
  thread_fork_native_siblings: {
    outgoing: ["initialize", "initialized", "thread/start", "thread/fork", "turn/start"],
    incoming: ["thread/started", "turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 3,
    turnCompletedCount: 3,
    approvalRequestCount: 0,
  },
  thread_merge_back_continue: {
    outgoing: ["initialize", "initialized", "thread/start", "thread/fork", "turn/start"],
    incoming: ["thread/started", "turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 4,
    turnCompletedCount: 4,
    approvalRequestCount: 0,
  },
  thread_merge_back_siblings: {
    outgoing: ["initialize", "initialized", "thread/start", "thread/fork", "turn/start"],
    incoming: ["thread/started", "turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 6,
    turnCompletedCount: 6,
    approvalRequestCount: 0,
  },
  todo_list: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["turn/started", "turn/completed", "turn/plan/updated", "item/agentMessage/delta"],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 0,
  },
  web_search: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 0,
  },
} as const;

const decodeCodexTranscript = Schema.decodeUnknownEffect(
  CodexReplay.CodexAppServerReplayTranscript,
);
const readTranscript = Effect.fn("readCodexReplayFixture")(function* (file: URL) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(decodeURIComponent(file.pathname));
  return yield* decodeProviderReplayNdjson(text);
}, Effect.provide(NodeServices.layer));

function labels(
  transcript: ProviderReplayTranscript,
  type: "expect_outbound" | "emit_inbound",
): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (entry.type !== type || entry.label === undefined) {
      return [];
    }
    return [entry.label];
  });
}

function countLabel(
  transcript: ProviderReplayTranscript,
  type: "expect_outbound" | "emit_inbound",
  label: string,
) {
  return labels(transcript, type).filter((entryLabel) => entryLabel === label).length;
}

function countApprovalRequests(transcript: ProviderReplayTranscript) {
  return labels(transcript, "emit_inbound").filter((label) => label.endsWith("/requestApproval"))
    .length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(value: unknown, path: ReadonlyArray<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        throw new Error(`Expected array while reading ${path.join(".")}.`);
      }
      current = current[segment];
      continue;
    }

    if (!isRecord(current)) {
      throw new Error(`Expected object while reading ${path.join(".")}.`);
    }
    current = current[segment];
  }
  return current;
}

function readString(value: unknown, path: ReadonlyArray<string | number>): string {
  const current = readPath(value, path);
  if (typeof current !== "string") {
    throw new Error(`Expected string at ${path.join(".")}.`);
  }
  return current;
}

function readArray(value: unknown, path: ReadonlyArray<string | number>): ReadonlyArray<unknown> {
  const current = readPath(value, path);
  if (!Array.isArray(current)) {
    throw new Error(`Expected array at ${path.join(".")}.`);
  }
  return current;
}

function findProtocolEntry(
  transcript: ProviderReplayTranscript,
  type: "expect_outbound" | "emit_inbound",
  label: string,
  occurrence = 0,
): ProtocolReplayEntry {
  const matches = transcript.entries.filter(
    (entry): entry is ProtocolReplayEntry => entry.type === type && entry.label === label,
  );
  const entry = matches[occurrence];
  if (!entry) {
    throw new Error(`Missing ${type} ${label} occurrence ${occurrence}.`);
  }
  return entry;
}

function agentMessageTexts(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound" || entry.label !== "item/completed") {
      return [];
    }

    const item = readPath(entry.frame, ["params", "item"]);
    if (!isRecord(item) || item.type !== "agentMessage" || typeof item.text !== "string") {
      return [];
    }
    return [item.text];
  });
}

function assertScenarioExpectations(transcript: ProviderReplayTranscript) {
  const expectation =
    scenarioExpectations[transcript.scenario as keyof typeof scenarioExpectations];
  const outgoingLabels = labels(transcript, "expect_outbound");
  const incomingLabels = labels(transcript, "emit_inbound");

  assert.isDefined(expectation, `missing scenario expectation for ${transcript.scenario}`);
  for (const label of expectation.outgoing) {
    assert.include(outgoingLabels, label, `${transcript.scenario} missing outgoing ${label}`);
  }
  for (const label of expectation.incoming) {
    assert.include(incomingLabels, label, `${transcript.scenario} missing incoming ${label}`);
  }

  assert.equal(countLabel(transcript, "expect_outbound", "turn/start"), expectation.turnStartCount);
  assert.equal(
    countLabel(transcript, "emit_inbound", "turn/completed"),
    expectation.turnCompletedCount,
  );
  assert.equal(countApprovalRequests(transcript), expectation.approvalRequestCount);
}

function assertProviderThreadResumeSemantics(transcript: ProviderReplayTranscript) {
  if (transcript.scenario !== "provider_thread_resume") {
    return;
  }

  const startThreadId = readString(
    findProtocolEntry(transcript, "emit_inbound", "thread/start").frame,
    ["result", "thread", "id"],
  );
  const resumeRequestedThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "thread/resume").frame,
    ["params", "threadId"],
  );
  const resumedThreadFrame = findProtocolEntry(transcript, "emit_inbound", "thread/resume").frame;
  const resumedThreadId = readString(resumedThreadFrame, ["result", "thread", "id"]);
  const resumedTurns = readArray(resumedThreadFrame, ["result", "thread", "turns"]);
  const secondTurnThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "turn/start", 1).frame,
    ["params", "threadId"],
  );
  const texts = agentMessageTexts(transcript);
  const secondFinalText = texts[1] ?? "";

  assert.equal(
    resumeRequestedThreadId,
    startThreadId,
    "thread/resume must request the provider thread created by thread/start",
  );
  assert.equal(
    resumedThreadId,
    startThreadId,
    "thread/resume must return the same provider thread id",
  );
  assert.equal(
    secondTurnThreadId,
    startThreadId,
    "turn after resume must run on the resumed provider thread",
  );
  assert.isAtLeast(resumedTurns.length, 1, "thread/resume response must include prior turns");

  const resumedFirstTurnItems = readArray(resumedTurns[0], ["items"]);
  const resumedFirstTurnAgentText = resumedFirstTurnItems
    .filter(isRecord)
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text)
    .find((text): text is string => typeof text === "string");

  assert.equal(
    resumedFirstTurnAgentText,
    PROVIDER_THREAD_RESUME_FIRST_FINAL,
    "thread/resume response must hydrate the prior assistant answer",
  );
  assert.include(
    secondFinalText,
    PROVIDER_THREAD_RESUME_FIRST_FINAL,
    "second turn must demonstrate access to resumed conversation history",
  );
  assert.include(
    secondFinalText,
    PROVIDER_THREAD_RESUME_SECOND_FINAL,
    "second turn must include its own completion marker",
  );
}

function assertContinuedForkSemantics(transcript: ProviderReplayTranscript) {
  if (transcript.scenario !== "thread_fork_native_continue") {
    return;
  }

  const sourceThreadId = readString(
    findProtocolEntry(transcript, "emit_inbound", "thread/start").frame,
    ["result", "thread", "id"],
  );
  const forkRequestThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "thread/fork").frame,
    ["params", "threadId"],
  );
  const forkThreadId = readString(
    findProtocolEntry(transcript, "emit_inbound", "thread/fork").frame,
    ["result", "thread", "id"],
  );
  const firstForkTurnThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "turn/start", 1).frame,
    ["params", "threadId"],
  );
  const secondForkTurnThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "turn/start", 2).frame,
    ["params", "threadId"],
  );
  const recallPrompt = readString(
    findProtocolEntry(transcript, "expect_outbound", "turn/start", 2).frame,
    ["params", "input", 0, "text"],
  );

  assert.equal(forkRequestThreadId, sourceThreadId);
  assert.notEqual(forkThreadId, sourceThreadId);
  assert.equal(firstForkTurnThreadId, forkThreadId);
  assert.equal(secondForkTurnThreadId, forkThreadId);
  assert.notInclude(recallPrompt, THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER);
  assert.notInclude(recallPrompt, THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER);
  const texts = agentMessageTexts(transcript);
  for (const expected of [
    "source marker stored",
    "fork marker stored",
    THREAD_FORK_NATIVE_CONTINUE_RECALL,
  ]) {
    assert.include(texts, expected);
  }
  assert.equal(
    texts.at(-1),
    THREAD_FORK_NATIVE_CONTINUE_RECALL,
    "the second fork-local turn must recall both the inherited source marker and fork-local marker",
  );
}

function assertSiblingForkSemantics(transcript: ProviderReplayTranscript) {
  if (transcript.scenario !== "thread_fork_native_siblings") {
    return;
  }

  const sourceThreadId = readString(
    findProtocolEntry(transcript, "emit_inbound", "thread/start").frame,
    ["result", "thread", "id"],
  );
  const firstForkFrame = findProtocolEntry(transcript, "emit_inbound", "thread/fork", 0).frame;
  const secondForkFrame = findProtocolEntry(transcript, "emit_inbound", "thread/fork", 1).frame;
  const firstForkId = readString(firstForkFrame, ["result", "thread", "id"]);
  const secondForkId = readString(secondForkFrame, ["result", "thread", "id"]);
  const firstForkParentId = readString(firstForkFrame, ["result", "thread", "forkedFromId"]);
  const secondForkParentId = readString(secondForkFrame, ["result", "thread", "forkedFromId"]);
  const firstForkTurnThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "turn/start", 1).frame,
    ["params", "threadId"],
  );
  const secondForkTurnThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "turn/start", 2).frame,
    ["params", "threadId"],
  );
  const texts = agentMessageTexts(transcript);
  const firstRecall = texts[1]?.replace(/\s*\|\s*/u, "|") ?? "";
  const secondRecall = texts[2]?.replace(/\s*\|\s*/u, "|") ?? "";

  assert.equal(firstForkParentId, sourceThreadId);
  assert.equal(secondForkParentId, sourceThreadId);
  assert.notEqual(firstForkId, secondForkId);
  assert.equal(firstForkTurnThreadId, firstForkId);
  assert.equal(secondForkTurnThreadId, secondForkId);
  assert.equal(firstRecall, "sibling-source-8R3D|sibling-first-5L2P");
  assert.notInclude(firstRecall, "sibling-second-9N6C");
  assert.equal(secondRecall, "sibling-source-8R3D|sibling-second-9N6C");
  assert.notInclude(secondRecall, "sibling-first-5L2P");
}

function assertMergeBackSemantics(transcript: ProviderReplayTranscript) {
  if (transcript.scenario !== "thread_merge_back_continue") {
    return;
  }

  const sourceThreadId = readString(
    findProtocolEntry(transcript, "emit_inbound", "thread/start").frame,
    ["result", "thread", "id"],
  );
  const forkThreadId = readString(
    findProtocolEntry(transcript, "emit_inbound", "thread/fork").frame,
    ["result", "thread", "id"],
  );
  const mergeThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "turn/start", 2).frame,
    ["params", "threadId"],
  );
  const recallFrame = findProtocolEntry(transcript, "expect_outbound", "turn/start", 3).frame;
  const recallThreadId = readString(recallFrame, ["params", "threadId"]);
  const recallPrompt = readString(recallFrame, ["params", "input", 0, "text"]);
  const texts = agentMessageTexts(transcript);

  assert.notEqual(forkThreadId, sourceThreadId);
  assert.equal(mergeThreadId, sourceThreadId);
  assert.equal(recallThreadId, sourceThreadId);
  assert.notInclude(recallPrompt, THREAD_MERGE_BACK_SOURCE_MARKER);
  assert.notInclude(recallPrompt, THREAD_MERGE_BACK_FORK_MARKER);
  assert.equal(texts.at(-1)?.replace(/\s*\|\s*/u, "|"), THREAD_MERGE_BACK_RECALL);
}

function assertSiblingMergeBackSemantics(transcript: ProviderReplayTranscript) {
  if (transcript.scenario !== "thread_merge_back_siblings") {
    return;
  }

  const sourceThreadId = readString(
    findProtocolEntry(transcript, "emit_inbound", "thread/start").frame,
    ["result", "thread", "id"],
  );
  const firstForkId = readString(
    findProtocolEntry(transcript, "emit_inbound", "thread/fork", 0).frame,
    ["result", "thread", "id"],
  );
  const secondForkId = readString(
    findProtocolEntry(transcript, "emit_inbound", "thread/fork", 1).frame,
    ["result", "thread", "id"],
  );
  const firstMergeThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "turn/start", 3).frame,
    ["params", "threadId"],
  );
  const secondMergeThreadId = readString(
    findProtocolEntry(transcript, "expect_outbound", "turn/start", 4).frame,
    ["params", "threadId"],
  );
  const recallFrame = findProtocolEntry(transcript, "expect_outbound", "turn/start", 5).frame;
  const recallPrompt = readString(recallFrame, ["params", "input", 0, "text"]);
  const finalText = agentMessageTexts(transcript)
    .at(-1)
    ?.replace(/\s*\|\s*/gu, "|");

  assert.notEqual(firstForkId, secondForkId);
  assert.equal(firstMergeThreadId, sourceThreadId);
  assert.equal(secondMergeThreadId, sourceThreadId);
  assert.notInclude(recallPrompt, THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER);
  assert.notInclude(recallPrompt, THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER);
  assert.notInclude(recallPrompt, THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER);
  assert.equal(finalText, THREAD_MERGE_BACK_SIBLINGS_RECALL);
}

describe("Codex replay fixtures", () => {
  it.effect("loads every current Codex fixture as a codex app-server replay transcript", () =>
    Effect.gen(function* () {
      for (const fixture of CODEX_REPLAY_FIXTURES) {
        const transcript = yield* readTranscript(fixture.transcriptFile);
        const codexTranscript = yield* decodeCodexTranscript(transcript);
        const first = transcript.entries[0];

        assert.equal(codexTranscript.provider, "codex");
        assert.equal(codexTranscript.protocol, "codex.app-server");
        assert.equal(codexTranscript.scenario, fixture.scenario);
        assert.deepEqual(codexTranscript.entries.at(-1), {
          type: "runtime_exit",
          status: "success",
        });
        assert.equal(first?.type, "expect_outbound");
        if (first?.type !== "expect_outbound") {
          throw new Error(`Expected ${fixture.scenario} to start with initialize outbound frame.`);
        }
        assert.equal(first.label, "initialize");

        assertScenarioExpectations(transcript);
        assertProviderThreadResumeSemantics(transcript);
        assertContinuedForkSemantics(transcript);
        assertSiblingForkSemantics(transcript);
        assertMergeBackSemantics(transcript);
        assertSiblingMergeBackSemantics(transcript);
      }
    }),
  );

  it.effect("covers the expected replay suite exactly", () =>
    Effect.gen(function* () {
      const transcripts = yield* Effect.forEach(CODEX_REPLAY_FIXTURES, (fixture) =>
        readTranscript(fixture.transcriptFile),
      );

      assert.deepEqual(
        transcripts.map((transcript) => transcript.scenario).toSorted(),
        Object.keys(scenarioExpectations).toSorted(),
      );
    }),
  );
});
