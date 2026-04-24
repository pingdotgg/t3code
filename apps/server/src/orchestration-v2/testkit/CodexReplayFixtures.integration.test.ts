import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as CodexReplay from "effect-codex-app-server/replay";
import { Effect, Schema } from "effect";
import { readFile } from "node:fs/promises";

import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

const PROVIDER_THREAD_RESUME_FIRST_FINAL = "provider thread resume fixture first turn complete";
const PROVIDER_THREAD_RESUME_SECOND_FINAL = "provider thread resume fixture second turn complete";

type ProtocolReplayEntry = Extract<
  ProviderReplayTranscript["entries"][number],
  { readonly type: "expect_outbound" | "emit_inbound" }
>;

const CODEX_REPLAY_FIXTURES = ORCHESTRATOR_REPLAY_FIXTURES.flatMap((fixture) =>
  fixture.providers
    .filter((provider) => provider.provider === "codex")
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
  multi_turn: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start"],
    incoming: ["turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 2,
    turnCompletedCount: 2,
    approvalRequestCount: 0,
  },
  provider_thread_resume: {
    outgoing: ["initialize", "initialized", "thread/start", "thread/resume", "turn/start"],
    incoming: ["thread/started", "turn/started", "turn/completed", "item/agentMessage/delta"],
    turnStartCount: 2,
    turnCompletedCount: 2,
    approvalRequestCount: 0,
  },
  message_steering: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start", "turn/steer"],
    incoming: [
      "turn/started",
      "turn/completed",
      "item/agentMessage/delta",
      "item/commandExecution/requestApproval",
      "serverRequest/resolved",
    ],
    turnStartCount: 1,
    turnCompletedCount: 1,
    approvalRequestCount: 1,
  },
  turn_interrupt: {
    outgoing: ["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt"],
    incoming: ["turn/started", "turn/completed"],
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
} as const;

async function readTranscript(file: URL): Promise<ProviderReplayTranscript> {
  const text = await readFile(file, "utf8");
  return await Effect.runPromise(decodeProviderReplayNdjson(text));
}

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

describe("Codex replay fixtures", () => {
  it("loads every current Codex fixture as a codex app-server replay transcript", async () => {
    for (const fixture of CODEX_REPLAY_FIXTURES) {
      const transcript = await readTranscript(fixture.transcriptFile);
      const codexTranscript = Schema.decodeUnknownSync(CodexReplay.CodexAppServerReplayTranscript)(
        transcript,
      );
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
    }
  });

  it("covers the expected replay suite exactly", async () => {
    const transcripts = await Promise.all(
      CODEX_REPLAY_FIXTURES.map((fixture) => readTranscript(fixture.transcriptFile)),
    );

    assert.deepEqual(
      transcripts.map((transcript) => transcript.scenario).toSorted(),
      Object.keys(scenarioExpectations).toSorted(),
    );
  });
});
