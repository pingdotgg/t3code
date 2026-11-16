#!/usr/bin/env node
// Writes the hand-made ACP scenarios in testdata/<flavor>-scenarios/ from recorded T3 test kit
// transcripts in the Conn monorepo:
//
//   node crates/conn-provider-acp/tools/make-scenarios.mjs
//
// A scenario covers a path that no T3 recording has. Each is a recorded transcript with turns
// changed or added by the rules below, and an `input.json` (T3's `OrchestratorFixtureInput`).
// The frames are not from a live agent. `capture-ts-events.mjs` then runs each scenario through
// T3's own fixture runner and Grok adapter, so T3's adapter, not this script, decides what the
// events and the prompts must be.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo } from "../../../tools/monorepo.mjs";

const MONOREPO = monorepo();
const CRATE = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const FIXTURES = NodePath.join(MONOREPO, "apps/server/src/orchestration-v2/testkit/fixtures");

const readTranscript = (fixture, file) =>
  NodeFS.readFileSync(NodePath.join(FIXTURES, fixture, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const SESSION = "00000000-0000-4000-8000-000000000001";
const FIRST = "Respond with exactly: first fixture turn complete";
const SECOND = "Respond with exactly: second fixture turn complete";

const isPrompt = (entry) =>
  entry.type === "expect_outbound" && entry.frame?.method === "session/prompt";
const isClose = (entry) =>
  entry.type === "expect_outbound" && entry.frame?.method === "session/close";

/** multi_turn split into the part before the second prompt, the second turn and the close. */
function multiTurnParts() {
  const entries = readTranscript("multi_turn", "grok_transcript.ndjson");
  const prompts = entries.flatMap((entry, index) => (isPrompt(entry) ? [index] : []));
  const close = entries.findIndex(isClose);
  if (prompts.length !== 2 || close === -1) throw new Error("multi_turn has a new shape");
  return {
    head: entries.slice(0, prompts[1]),
    second: entries.slice(prompts[1], close),
    tail: entries.slice(close),
  };
}

const notification = (label, method, params) => ({
  type: "emit_inbound",
  label,
  frame: { kind: "notification", method, params },
});
const sessionUpdate = (update) =>
  notification(`notification:session/update:${update.sessionUpdate}`, "session/update", {
    sessionId: SESSION,
    update,
  });

/**
 * The recorded second turn, renumbered as prompt `n`, sent with `text` (T3's wrapper when
 * `wrapped`), its thoughts dropped and its answer replaced; `extra` goes before the answer.
 */
function turn(second, { n, text, wrapped, answer, extra = [] }) {
  const renumber = (entry) =>
    JSON.parse(JSON.stringify(entry).replaceAll("t3-xai-prompt-2", `t3-xai-prompt-${n}`));
  const out = [];
  let answered = false;
  for (const entry of second) {
    if (isPrompt(entry)) {
      const frame = renumber(entry).frame;
      frame.params.prompt = [
        {
          type: "text",
          text: wrapped
            ? `<t3_code_instructions>\n<any>\n</t3_code_instructions>\n\n<user_request>\n${text}\n</user_request>`
            : text,
        },
      ];
      out.push({ ...entry, frame });
      continue;
    }
    const update = entry.frame?.params?.update?.sessionUpdate;
    if (update === "agent_thought_chunk") continue;
    if (update === "agent_message_chunk") {
      if (!answered) {
        out.push(...extra, sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } }));
        answered = true;
      }
      continue;
    }
    // The queue echoes the prompt text; the scenario's text replaces the recorded one.
    out.push(JSON.parse(JSON.stringify(renumber(entry)).replaceAll(SECOND, text)));
  }
  return out;
}

const start = (scenario, note) => ({
  type: "transcript_start",
  provider: "grok",
  protocol: "acp.ndjson-jsonrpc",
  version: "1",
  scenario,
  metadata: {
    generatedBy: "conn-server tools/make-scenarios.mjs",
    note,
  },
});

function write(flavor, name, input, entries) {
  const dir = NodePath.join(CRATE, "testdata", `${flavor}-scenarios`, name);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "input.json"), `${JSON.stringify(input, null, 1)}\n`);
  NodeFS.writeFileSync(
    NodePath.join(dir, `${flavor}_transcript.ndjson`),
    `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  console.log(`${flavor}-scenarios/${name}: ${entries.length} entries`);
}

const { head, second, tail } = multiTurnParts();
const input = { steps: [FIRST, "/compact", SECOND].map((text) => ({ type: "message", text })) };
const body = head.filter((e) => e.type !== "transcript_start");

// Grok answers `/compact` as a plain turn: T3 shows "Context compacted", forgets the context
// usage, and resends its instructions and runtime notes with the next prompt.
write("grok", "grok_compact", input, [
  start("grok_compact", "multi_turn with a /compact turn between its two turns; Grok sends no compaction_update"),
  ...body,
  ...turn(second, { n: 2, text: "/compact", wrapped: false, answer: "Conversation compacted." }),
  ...turn(second, { n: 3, text: SECOND, wrapped: true, answer: "second fixture turn complete" }),
  ...tail,
]);

// The agent reports the compaction itself (ACP `compaction_update`, which T3 asks for with the
// `session.compaction` client capability): a "Compact context" item with the summary, its
// token count before, and no second "Context compacted" item.
const usage = sessionUpdate({ sessionUpdate: "usage_update", used: 21396, size: 256000 });
const compacting = [
  sessionUpdate({ sessionUpdate: "compaction_update", compactionId: "cmp-1", status: "in_progress" }),
  sessionUpdate({
    sessionUpdate: "compaction_summary_chunk",
    compactionId: "cmp-1",
    content: { type: "text", text: "The user asked for two fixed replies. " },
  }),
  sessionUpdate({
    sessionUpdate: "compaction_summary_chunk",
    compactionId: "cmp-1",
    content: { type: "text", text: "Both were given." },
  }),
  sessionUpdate({
    sessionUpdate: "compaction_update",
    compactionId: "cmp-1",
    status: "completed",
    summary: [{ type: "text", text: "The user asked for two fixed replies. Both were given." }],
  }),
  // A completed compaction patched again marks the session only once.
  sessionUpdate({ sessionUpdate: "compaction_update", compactionId: "cmp-1", status: "completed" }),
];
const firstPrompt = body.findIndex(isPrompt);
const firstAnswer = body.findIndex(
  (e, i) => i > firstPrompt && e.frame?.params?.update?.sessionUpdate === "agent_message_chunk",
);
write("grok", "grok_compact_update", input, [
  start(
    "grok_compact_update",
    "multi_turn with a usage_update in turn 1 and a /compact turn in which the agent sends compaction_update and summary chunks",
  ),
  ...body.slice(0, firstAnswer),
  usage,
  ...body.slice(firstAnswer),
  ...turn(second, { n: 2, text: "/compact", wrapped: false, answer: "Conversation compacted.", extra: compacting }),
  ...turn(second, { n: 3, text: SECOND, wrapped: true, answer: "second fixture turn complete" }),
  ...tail,
]);
