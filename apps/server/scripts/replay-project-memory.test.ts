import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { replayProjectMemory, type ReplayRow } from "./replay-project-memory.ts";

const facts = [
  {
    id: "fact-one",
    project_id: "replay-project",
    content: "Cache keys include tenant IDs.",
    entities_json: ["cache", "tenant"],
    tags_json: ["isolation"],
    origin_thread: "other-thread",
    trust: 0.5,
    created_at: "2026-11-02T03:39:00.936Z",
  },
];

const messages = [
  {
    message_id: "match",
    project_id: "replay-project",
    thread_id: "asking-thread",
    payload_json: JSON.stringify({
      text: "Change cache keys to include tenant IDs.",
      createdBy: "user",
    }),
  },
  {
    message_id: "greeting",
    project_id: "replay-project",
    thread_id: "asking-thread",
    text: "hello there",
    created_by: "agent",
  },
  {
    message_id: "unrelated",
    project_id: "replay-project",
    thread_id: "asking-thread",
    text: "garden bicycle banana weather holiday",
    created_by: "user",
  },
  {
    message_id: "slash",
    project_id: "replay-project",
    thread_id: "asking-thread",
    text: "/compact the tenant cache",
    created_by: "user",
  },
];

it.effect("replays invented facts through recall and names the gate", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-replay-test-" });
    const factsPath = path.join(directory, "facts.json");
    const messagesPath = path.join(directory, "msgs.json");
    const out = path.join(directory, "out");
    yield* fs.writeFileString(factsPath, JSON.stringify(facts));
    yield* fs.writeFileString(messagesPath, JSON.stringify(messages));
    const { rows, summary } = yield* replayProjectMemory({
      facts: factsPath,
      messages: messagesPath,
      out,
    });
    const byId = new Map(rows.map((row) => [row.messageId, row]));
    const match = byId.get("match");
    assert.equal(match?.gate, "delivered");
    assert.deepEqual(match?.deliveredFactIds, ["fact-one"]);
    assert.equal(match?.createdBy, "user");
    assert.equal(match?.characters, "Change cache keys to include tenant IDs.".length);
    assert.isAbove(match?.candidatesMs ?? -1, -1);
    assert.equal(typeof match?.candidatesMs, "number");
    assert.equal(match?.top[0]?.factId, "fact-one");
    assert.equal(match?.top[0]?.passedGate, true);
    for (const key of [
      "holographic",
      "lexical",
      "tokenOverlap",
      "temporalDecay",
      "reinforcement",
      "trust",
      "combined",
    ] as const) {
      assert.equal(typeof match?.top[0]?.score[key], "number");
    }
    assert.equal(byId.get("greeting")?.gate, "not_substantive");
    assert.equal(byId.get("greeting")?.candidatesMs, null);
    assert.deepEqual(byId.get("greeting")?.deliveredFactIds, []);
    assert.equal(byId.get("unrelated")?.gate, "no_match");
    assert.deepEqual(byId.get("unrelated")?.deliveredFactIds, []);
    assert.equal(byId.get("slash")?.gate, "slash");
    assert.equal(summary.byGate.delivered, 1);
    assert.equal(summary.byGate.not_substantive, 1);
    assert.equal(summary.byGate.no_match, 1);
    assert.equal(summary.byGate.slash, 1);
    assert.equal(summary.byCreatedBy.user?.messages, 3);
    assert.equal(summary.byCreatedBy.agent?.messages, 1);
    assert.equal(summary.lookupLatencyMs.n, 2);
    assert.equal(summary.factsLoaded, 1);
    const written = (
      JSON.parse(yield* fs.readFileString(path.join(out, "summary.json"))) as {
        messages: number;
      }
    ).messages;
    assert.equal(written, 4);
    const lines = (yield* fs.readFileString(path.join(out, "results.ndjson")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ReplayRow);
    assert.equal(lines.length, 4);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
