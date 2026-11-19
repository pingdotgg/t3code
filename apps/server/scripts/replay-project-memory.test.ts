// @effect-diagnostics processEnvInEffect:off - the guard reads HOME and T3CODE_HOME, and this test points both at a temp directory
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
      text: "Do the cache keys carry tenant IDs?",
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
  {
    message_id: "command-notice",
    project_id: "replay-project",
    thread_id: "asking-thread",
    payload_json: JSON.stringify({
      text: "Do the cache keys carry tenant IDs?",
      createdBy: "agent",
      notification: {
        source: { kind: "background_command" },
        outcome: "completed",
        summary: "npm test completed",
      },
    }),
  },
  {
    message_id: "delegated-completion",
    project_id: "replay-project",
    thread_id: "asking-thread",
    payload_json: JSON.stringify({
      text: "Do the cache keys carry tenant IDs?",
      createdBy: "system",
      creationSource: "server",
      delegatedCompletion: { parentRunId: "parent-run", generation: 1, taskIds: [] },
    }),
  },
  {
    message_id: "linked-peer",
    project_id: "replay-project",
    thread_id: "asking-thread",
    payload_json: JSON.stringify({
      text: "Do the cache keys carry tenant IDs?",
      createdBy: "user",
      creationSource: "mcp",
      linkedSender: { environmentId: "other-server", threadId: "peer", title: "Coordinator" },
    }),
  },
  {
    message_id: "local-peer",
    project_id: "replay-project",
    thread_id: "asking-thread",
    text: "Do the cache keys carry tenant IDs?",
    created_by: "user",
    creation_source: "mcp",
    sender_thread_id: "peer",
  },
  {
    message_id: "correction",
    project_id: "replay-project",
    thread_id: "asking-thread",
    text: "Stop using tenant IDs in cache keys. Use request IDs instead.",
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
    assert.equal(match?.characters, "Do the cache keys carry tenant IDs?".length);
    assert.isAbove(match?.candidatesMs ?? -1, -1);
    assert.equal(typeof match?.candidatesMs, "number");
    assert.equal(byId.get("greeting")?.gate, "nonhuman");
    assert.equal(byId.get("greeting")?.candidatesMs, null);
    assert.deepEqual(byId.get("greeting")?.deliveredFactIds, []);
    assert.equal(byId.get("unrelated")?.gate, "no_match");
    assert.deepEqual(byId.get("unrelated")?.deliveredFactIds, []);
    assert.equal(byId.get("slash")?.gate, "slash");
    assert.equal(byId.get("command-notice")?.gate, "progress_notice");
    assert.equal(byId.get("command-notice")?.candidatesMs, null);
    assert.deepEqual(byId.get("command-notice")?.deliveredFactIds, []);
    for (const [id, gate] of [
      ["delegated-completion", "progress_notice"],
      ["linked-peer", "nonhuman"],
      ["local-peer", "nonhuman"],
      ["correction", "current_correction"],
    ] as const) {
      assert.equal(byId.get(id)?.gate, gate);
      assert.equal(byId.get(id)?.candidatesMs, null);
      assert.deepEqual(byId.get(id)?.deliveredFactIds, []);
    }
    assert.equal(summary.byGate.delivered, 1);
    assert.equal(summary.byGate.no_match, 1);
    assert.equal(summary.byGate.slash, 1);
    assert.equal(summary.byGate.progress_notice, 2);
    assert.equal(summary.byGate.nonhuman, 3);
    assert.equal(summary.byGate.current_correction, 1);
    assert.equal(summary.byCreatedBy.user?.messages, 6);
    assert.equal(summary.byCreatedBy.agent?.messages, 2);
    assert.equal(summary.byCreatedBy.system?.messages, 1);
    assert.equal(summary.lookupLatencyMs.n, 2);
    assert.equal(summary.factsLoaded, 1);
    const written = (
      JSON.parse(yield* fs.readFileString(path.join(out, "summary.json"))) as {
        messages: number;
      }
    ).messages;
    assert.equal(written, 9);
    const lines = (yield* fs.readFileString(path.join(out, "results.ndjson")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ReplayRow);
    assert.equal(lines.length, 9);
    const scratch = yield* replayProjectMemory({
      facts: factsPath,
      messages: messagesPath,
      out,
      scratchProject: "replay-project",
    });
    assert.equal(scratch.rows.find((row) => row.messageId === "match")?.gate, "scratch_project");
    assert.equal(scratch.summary.byGate.delivered, 0);
    yield* fs.writeFileString(factsPath, "[]");
    const failure = yield* replayProjectMemory({
      facts: factsPath,
      messages: messagesPath,
      out,
      factCount: 1,
    }).pipe(
      Effect.as("unexpected success"),
      Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
    );
    assert.include(failure, "Cannot scale an empty fact corpus");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("refuses a case-variant path and a symlink into the stand-in state directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-replay-guard-" });
    const home = path.join(directory, "home");
    const state = path.join(home, ".t3", "userdata");
    yield* fs.makeDirectory(state, { recursive: true });
    const inputs = path.join(directory, "inputs");
    yield* fs.makeDirectory(inputs);
    const factsPath = path.join(inputs, "facts.json");
    const messagesPath = path.join(inputs, "msgs.json");
    yield* fs.writeFileString(factsPath, JSON.stringify(facts));
    yield* fs.writeFileString(messagesPath, JSON.stringify(messages));
    const link = path.join(directory, "state-link");
    yield* fs.symlink(state, link);
    const previousHome = process.env.HOME;
    const previousState = process.env.T3CODE_HOME;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousState === undefined) delete process.env.T3CODE_HOME;
        else process.env.T3CODE_HOME = previousState;
      }),
    );
    process.env.HOME = home;
    process.env.T3CODE_HOME = home;
    assert.equal(NodeOS.homedir(), home);

    const refusal = (out: string) =>
      replayProjectMemory({ facts: factsPath, messages: messagesPath, out }).pipe(
        Effect.exit,
        Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")),
      );
    const linkedOut = path.join(link, "out");
    assert.include(yield* refusal(linkedOut), "Refusing to touch live T3 data");
    assert.isFalse(yield* fs.exists(path.join(linkedOut, "results.ndjson")));

    const foldedOut = path.join(home, ".T3", "UserData", "out");
    const identity = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => (Option.isSome(info.ino) ? `${info.dev}:${info.ino.value}` : null)),
        Effect.orElseSucceed(() => null),
      );
    const stateId = yield* identity(state);
    const foldedId = yield* identity(path.dirname(foldedOut));
    if (stateId !== null && foldedId === stateId) {
      assert.include(yield* refusal(foldedOut), "Refusing to touch live T3 data");
      assert.isFalse(yield* fs.exists(path.join(state, "out", "results.ndjson")));
    } else {
      const distinct = yield* replayProjectMemory({
        facts: factsPath,
        messages: messagesPath,
        out: foldedOut,
      }).pipe(Effect.exit);
      const message = Exit.isFailure(distinct) ? Cause.pretty(distinct.cause) : "";
      assert.notInclude(message, "Refusing to touch live T3 data");
    }

    const allowed = yield* replayProjectMemory({
      facts: factsPath,
      messages: messagesPath,
      out: path.join(directory, "allowed"),
    });
    assert.equal(allowed.summary.factsLoaded, 1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
