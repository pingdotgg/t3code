// Decodes the engine's stream output as the RPC client does, applies it with the client's
// reducers, and checks the resulting state. Input: `examples/export_turn.rs` output.
// Run: CONN_MONOREPO=<conn checkout> node crates/conn-engine/tools/client-check.mjs <export.json>
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo } from "../../../tools/monorepo.mjs";

const assert = NodeAssert.strict;
const fs = NodeFS;
const path = NodePath;
const { fileURLToPath, pathToFileURL } = NodeURL;

// The Conn monorepo holds the contract and the client code under test.
const repo = monorepo();
const load = (file) => import(pathToFileURL(path.join(repo, file)).href);
// The workspace's own `effect`, so schemas and the code under test share one instance.
const effect = fs.realpathSync(path.join(repo, "packages/client-runtime/node_modules/effect"));
const Schema = await import(pathToFileURL(path.join(effect, "dist/Schema.js")).href);

const contracts = await load("packages/contracts/src/index.ts");
const { applyShellStreamEvents, mergeShellSnapshotProjects } = await load(
  "packages/client-runtime/src/state/shellReducer.ts",
);
const { applyOrchestrationV2ProjectionEvent } = await load(
  "packages/client-runtime/src/state/orchestrationV2Projection.ts",
);
const { presentRunStop } = await load("packages/client-runtime/src/state/threadExecution.ts");
const { boundedSnapshotProjection } = await load(
  "packages/shared/src/orchestrationV2BoundedSnapshot.ts",
);

const exportPath = process.argv[2];
if (!exportPath) throw new Error("usage: client-check.mjs <export.json>");
const exported = JSON.parse(fs.readFileSync(exportPath, "utf8"));

// As the RPC client decodes a chunk: `Schema.toCodecJson` of a non-empty array of items.
const decodeShellChunk = Schema.decodeUnknownSync(
  Schema.toCodecJson(Schema.NonEmptyArray(contracts.OrchestrationV2ShellStreamItem)),
);
const decodeThreadChunk = Schema.decodeUnknownSync(
  Schema.toCodecJson(Schema.NonEmptyArray(contracts.OrchestrationV2ThreadStreamItem)),
);
const decodeLaunchResult = Schema.decodeUnknownSync(
  Schema.toCodecJson(contracts.OrchestrationV2ThreadLaunchResult),
);
const decodeDetailSnapshot = Schema.decodeUnknownSync(
  Schema.toCodecJson(contracts.OrchestrationV2ThreadDetailSnapshot),
);
const encodeProjection = Schema.encodeSync(
  Schema.toCodecJson(contracts.OrchestrationV2ThreadProjection),
);

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
};

/** `state/shell.ts` applyLocked: snapshots merge, `synchronized` goes live, deltas apply. */
function followShell(items) {
  let snapshot = null;
  let status = "synchronizing";
  for (const raw of items) {
    const [item] = decodeShellChunk([raw]);
    if (item.kind === "snapshot") {
      snapshot = mergeShellSnapshotProjects(snapshot, item.snapshot);
    } else if (item.kind === "synchronized") {
      status = "live";
    } else if (item.kind === "snapshot-required") {
      throw new Error("unexpected snapshot-required");
    } else {
      assert.ok(snapshot, `${item.kind} arrived before a snapshot`);
      snapshot = applyShellStreamEvents(snapshot, [item]);
    }
  }
  return { snapshot, status };
}

/** `state/threads.ts` applyItems: a snapshot resets, events at or below the cursor are skipped. */
function followThread(items, start = null) {
  let projection = start?.projection ?? null;
  let sequence = start?.snapshotSequence ?? 0;
  let status = "synchronizing";
  let applied = 0;
  for (const raw of items) {
    const [item] = decodeThreadChunk([raw]);
    if (item.kind === "synchronized") {
      status = "live";
    } else if (item.kind === "snapshot") {
      projection = boundedSnapshotProjection(item);
      sequence = item.snapshotSequence;
    } else if (item.kind === "unknown-event") {
      throw new Error(`the client does not know event type ${item.eventType}`);
    } else {
      if (item.sequence <= sequence) continue;
      sequence = item.sequence;
      projection = applyOrchestrationV2ProjectionEvent(projection, item.event);
      applied += 1;
    }
  }
  return { projection, sequence, status, applied };
}

const visible = (projection) =>
  projection.visibleTurnItems.map((row) => ({
    type: row.item.type,
    text: row.item.text ?? row.item.failure?.message ?? null,
    streaming: row.item.streaming ?? null,
    position: row.position,
  }));

// 1. The shell stream shows the project and the new thread, and goes live.
const shell = followShell(exported.shellItems);
const threadRow = shell.snapshot.threads.find((thread) => thread.id === "thread-1");
check("shell: snapshot, project and new thread", () => {
  assert.equal(shell.status, "live");
  assert.equal(shell.snapshot.projects.length, 1);
  assert.equal(shell.snapshot.projects[0].workspaceRoot, "/tmp/conn-engine-export-project");
  assert.ok(threadRow, "thread-1 is in the shell");
  assert.equal(threadRow.title, "Say hello");
  assert.equal(threadRow.projectId, shell.snapshot.projects[0].id);
  assert.equal(threadRow.status, "completed");
  assert.equal(threadRow.activeRunId, null);
  assert.equal(threadRow.itemCount, 2);
  assert.equal(
    shell.snapshot.snapshotSequence,
    exported.shellItems.findLast((item) => item.sequence !== undefined).sequence,
  );
});

// 2. launchThread answers in the contract's shape.
check("launchThread: result decodes", () => {
  const launch = decodeLaunchResult(exported.launch);
  assert.equal(launch.threadId, "thread-1");
  assert.equal(launch.resumed, false);
  assert.equal(launch.projection.messages[0].text, "Say hello");
});

// 3. The thread view: HTTP snapshot, then the stream after its sequence.
const http = decodeDetailSnapshot(exported.threadHttp);
const live = followThread(exported.threadItems, http);
check("thread: user message and assistant reply", () => {
  assert.equal(live.status, "live");
  assert.ok(live.applied > 0, "events applied");
  assert.deepEqual(
    visible(live.projection).map(({ type, text, streaming }) => ({ type, text, streaming })),
    [
      { type: "user_message", text: "Say hello", streaming: null },
      { type: "assistant_message", text: "echo: Say hello", streaming: false },
    ],
  );
  const roles = live.projection.messages.map((message) => [
    message.role,
    message.text,
    message.streaming,
  ]);
  assert.deepEqual(roles, [
    ["user", "Say hello", false],
    ["assistant", "echo: Say hello", false],
  ]);
  assert.deepEqual(
    live.projection.runs.map((run) => run.status),
    ["completed"],
  );
  assert.equal(live.projection.thread.activeProviderThreadId, "provider-thread:thread-1");
});

// 4. A client that rebuilt the thread from events holds what a fresh snapshot holds.
const socket = followThread(exported.socketItems);
check("thread: events rebuild the same projection as a snapshot", () => {
  assert.equal(socket.status, "live");
  const strip = (projection) => {
    const { updatedAt: _ignored, ...rest } = encodeProjection(projection);
    return rest;
  };
  assert.deepEqual(strip(live.projection), strip(socket.projection));
});

// 5. After a restart during a turn, the turn ends as cancelled and continues in a new run.
const restartShell = followShell(exported.restartShellItems);
const restartThread = followThread(exported.restartThreadItems);
check("restart: the cut turn is cancelled and continues", () => {
  const row = restartShell.snapshot.threads.find((thread) => thread.id === "thread-2");
  assert.equal(row.status, "completed");
  assert.equal(row.activeRunId, null);
  assert.deepEqual(
    restartThread.projection.runs.map((run) => [
      run.status,
      run.restartContinuationOfRunId ?? null,
    ]),
    [
      ["cancelled", null],
      ["completed", "run:thread-2:1"],
    ],
  );
  assert.deepEqual(
    visible(restartThread.projection).map((item) => item.type),
    ["user_message", "system_notice", "user_message", "assistant_message"],
  );
  const continuation = restartThread.projection.messages.find((m) => m.createdBy === "agent");
  assert.match(continuation.text, /^Continue where you left off\./);
  assert.equal(restartShell.snapshot.threads.find((t) => t.id === "thread-1").status, "completed");
});

// 6. A compact snapshot (deduped bodies, turn items once) restores to the full projection.
const compact = followThread(exported.compactItems);
check("thread: a compact snapshot restores to the full projection", () => {
  const raw = exported.compactItems[0];
  assert.equal(raw.turnItemsOmitLocalVisible, true);
  assert.deepEqual(raw.projection.turnItems, []);
  assert.ok(raw.projection.visibleTurnItems.every((row) => row.item.textOmitted === true));
  const strip = (projection) => {
    const { updatedAt: _ignored, ...rest } = encodeProjection(projection);
    return rest;
  };
  assert.deepEqual(strip(compact.projection), strip(socket.projection));
});

// 7. A message sent during a turn queues, then runs after the interrupted turn.
const queue = followThread(exported.queueItems);
check("queue: a message sent during a turn runs after it", () => {
  assert.deepEqual(
    queue.projection.runs.map((run) => run.status),
    ["interrupted", "completed"],
  );
  assert.deepEqual(
    visible(queue.projection).map(({ type, text }) => [type, text]),
    [
      ["user_message", "hang"],
      ["run_interrupt_request", null],
      ["run_interrupt_result", null],
      ["user_message", "after that"],
      ["assistant_message", "echo: after that"],
    ],
  );
  const queued = queue.projection.visibleTurnItems.find(
    (row) => row.item.type === "user_message" && row.item.text === "after that",
  ).item;
  assert.equal(queued.inputIntent, "queued_turn");
});

// 8. A Stop the provider never confirms offers Force stop; Force stop ends the run.
check("stop: an unconfirmed Stop is unresponsive until Force stop", () => {
  const before = followThread(exported.stopItems.slice(0, exported.stopUnresponsiveAt));
  const shown = presentRunStop(before.projection);
  assert.equal(shown?.state, "unresponsive");
  assert.equal(shown?.background, false);
  const after = followThread(exported.stopItems);
  assert.deepEqual(
    after.projection.runs.map((run) => run.status),
    ["interrupted"],
  );
  assert.equal(presentRunStop(after.projection), null);
});

// 9. Projects added and removed at runtime reach the shell.
check("projects: added and removed at runtime", () => {
  const kinds = exported.shellItems.map((item) => item.kind);
  assert.ok(kinds.includes("project.updated") && kinds.includes("project.removed"));
  assert.equal(shell.snapshot.projects.length, 1);
  assert.ok(!shell.snapshot.projects.some((project) => project.id === "project:added"));
});

console.log(`\n${checks} checks passed against the client's own decoders and reducers.`);
