// Decodes the engine's stream output as the RPC client does, applies it with the client's
// reducers, and checks the resulting state. Input: `examples/export_turn.rs` output.
// Run: node crates/conn-engine/tools/client-check.mjs <export.json>
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
const { derivePendingBackgroundWork } = await load(
  "packages/shared/src/orchestrationV2PendingBackgroundWork.ts",
);
const { deriveThreadCheckpointSummaries, checkpointFileTotals } = await load(
  "packages/client-runtime/src/state/threadCheckpoints.ts",
);
const { resolveMergeBackTargetThreadId, deriveThreadRelationshipGraph } = await load(
  "packages/client-runtime/src/state/threadRelationships.ts",
);
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

// 8b. A Stop during a slow start ends the run in the Stop's own commit, as T3's "before
// provider start": the client never shows "Stopping", and the result says why.
check("stop: a Stop before the provider started ends the run at once", () => {
  const before = followThread(exported.coldStopItems.slice(0, exported.coldStopAt));
  assert.deepEqual(before.projection.runs.map((run) => run.status), ["running"]);
  const after = followThread(exported.coldStopItems);
  assert.deepEqual(after.projection.runs.map((run) => run.status), ["interrupted"]);
  assert.equal(presentRunStop(after.projection), null);
  const items = after.projection.turnItems.filter((item) => item.type.startsWith("run_interrupt"));
  assert.deepEqual(
    items.map((item) => [item.type, item.status, item.message, item.providerTurnId]),
    [
      ["run_interrupt_request", "completed", "Stopped by user", null],
      ["run_interrupt_result", "interrupted", "Run interrupted before provider start", null],
    ],
  );
  assert.equal(items[1].parentItemId, items[0].id);
  // Request, result, attempt, node and run arrive in that order, in one commit.
  const stopped = exported.coldStopItems
    .slice(exported.coldStopAt)
    .filter((item) => item.kind === "event")
    .map((item) => item.event.type);
  assert.deepEqual(stopped.slice(0, 5), [
    "turn-item.updated",
    "turn-item.updated",
    "run-attempt.updated",
    "node.updated",
    "run.updated",
  ]);
});

// 9. Background work left running: the shell row's roster is what T3's own
// derivePendingBackgroundWork makes of the same thread.
check("background: the shell roster matches T3's derivePendingBackgroundWork", () => {
  const [row] = Schema.decodeUnknownSync(
    Schema.toCodecJson(Schema.NonEmptyArray(contracts.OrchestrationV2ThreadShell)),
  )([exported.backgroundShell]);
  const { projection } = followThread(exported.backgroundItems);
  const started = projection.runs.filter((run) => run.status !== "queued");
  const latestRun = started.reduce(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  const expected = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs: projection.runs,
    pullRequests: projection.thread.pullRequests,
  });
  assert.ok(expected.length > 0, "the scenario leaves background work");
  assert.deepEqual(row.pendingBackgroundTasks, expected);
});

// 10. Projects added and removed at runtime reach the shell.
check("projects: added and removed at runtime", () => {
  const kinds = exported.shellItems.map((item) => item.kind);
  assert.ok(kinds.includes("project.updated") && kinds.includes("project.removed"));
  assert.equal(shell.snapshot.projects.length, 1);
  assert.ok(!shell.snapshot.projects.some((project) => project.id === "project:added"));
});

// 11. Checkpoints per turn: the client lists each turn's changed files; a rewind to the
// first turn leaves the second rolled back and its checkpoint stale.
check("checkpoints: each turn's changed files, then a rewind", () => {
  const { projection, status } = followThread(exported.checkpointItems);
  assert.equal(status, "live");
  assert.deepEqual(
    projection.runs.map((run) => [run.status, run.checkpointId !== null]),
    [
      ["completed", true],
      ["rolled_back", true],
    ],
  );
  const summaries = deriveThreadCheckpointSummaries(projection);
  assert.deepEqual(
    summaries.map((s) => [s.checkpointTurnCount, s.status, s.files.map((f) => f.path)]),
    [
      [1, "ready", ["a.txt"]],
      [2, "stale", ["b.txt"]],
    ],
  );
  assert.deepEqual(checkpointFileTotals(summaries[0]), { count: 1, additions: 1, deletions: 0 });
  assert.ok(
    summaries.every((s) => s.assistantMessageId !== null),
    "each turn's reply anchors its changed files",
  );
  assert.equal(projection.checkpointScopes.length, 1);
  assert.equal(projection.checkpointScopes[0].kind, "root_run");
  assert.equal(projection.thread.rollbackRequestId, "cp-rollback");
  assert.equal(projection.thread.rollbackFailure, null);
  assert.equal(
    projection.providerThreads.find((t) => t.id === projection.thread.activeProviderThreadId)
      .lastRunOrdinal,
    1,
  );
  const items = projection.turnItems.filter((item) => item.type === "checkpoint");
  assert.deepEqual(
    items.map((item) => item.files.map((f) => f.path)),
    [["a.txt"], ["b.txt"]],
  );
});

// 12. A fork of the first turn: its lineage, its native fork, and the client's graph.
check("fork: lineage, a native fork, and the relationship graph", () => {
  const { projection, status } = followThread(exported.forkItems);
  assert.equal(status, "live");
  assert.equal(projection.thread.lineage.relationshipToParent, "fork");
  assert.equal(projection.thread.forkedFrom.type, "run");
  assert.equal(projection.thread.forkedFrom.runId, "run:thread-cp:1");
  assert.equal(resolveMergeBackTargetThreadId(projection), "thread-cp");
  assert.deepEqual(
    projection.runs.map((run) => run.status),
    ["completed"],
  );
  const [transfer] = projection.contextTransfers;
  assert.equal(transfer.type, "fork");
  assert.equal(transfer.status, "consumed");
  assert.equal(transfer.resolution.strategy, "native_fork");
  const shells = Schema.decodeUnknownSync(
    Schema.toCodecJson(Schema.Array(contracts.OrchestrationV2ThreadShell)),
  )(exported.checkpointShellThreads);
  const graph = deriveThreadRelationshipGraph({ threads: shells, projection });
  const edges = [...(Array.isArray(graph.edges) ? graph.edges : graph.edges.values())];
  assert.ok(
    edges.some(
      (edge) =>
        edge.kind === "fork" &&
        edge.sourceThreadId === "thread-cp" &&
        edge.targetThreadId === "thread-cp-fork",
    ),
    `a fork edge: ${JSON.stringify(edges.map((e) => [e.kind, e.sourceThreadId, e.targetThreadId]))}`,
  );
});

// Merge-back: the fork's turn merged into its source (`mergeThreadBack`), then the source's
// next message. The pending transfer, its consumption, the handoff and its timeline item,
// through the client's decoder and reducers.
check("merge-back: a pending transfer, then the fork's delta in the next run", () => {
  const items = exported.mergeBackItems;
  const created = items.find((item) => item.event?.type === "context-transfer.created");
  assert.ok(created, "the merge-back records a transfer");
  assert.equal(created.event.payload.type, "merge_back");
  assert.equal(created.event.payload.status, "pending");
  assert.equal(created.event.payload.sourcePoint.runId, "run:thread-cp-fork:1");
  assert.equal(created.event.payload.basePoint.runId, "run:thread-cp:1");
  const { projection, status } = followThread(items);
  assert.equal(status, "live");
  const merges = projection.contextTransfers.filter((t) => t.type === "merge_back");
  assert.equal(merges.length, 1);
  const [merge] = merges;
  assert.equal(merge.status, "consumed");
  assert.equal(merge.targetRunId, "run:thread-cp:3");
  assert.equal(merge.resolution.strategy, "fork_delta_context");
  const [handoff] = projection.contextHandoffs;
  assert.equal(merge.resolution.contextHandoffId, handoff.id);
  assert.equal(handoff.strategy, "fork_delta_summary");
  assert.equal(handoff.targetRunId, "run:thread-cp:3");
  assert.ok(
    handoff.summaryText.startsWith(
      "Merge-back context from forked conversation.\nSource thread: thread-cp-fork\nTarget thread: thread-cp\nCovered fork runs: 1-1\n\nFork delta:\n- User: go on",
    ),
    handoff.summaryText,
  );
  // The fake provider has no native history injection: the history went inline.
  assert.equal(handoff.delivery?.status, "inline");
  const run = projection.runs.find((r) => r.id === "run:thread-cp:3");
  assert.equal(run.contextHandoffId, handoff.id);
  assert.equal(run.status, "completed");
  const visible = projection.visibleTurnItems.map(({ item }) => item);
  const marker = visible.findIndex((item) => item.type === "handoff");
  const message = visible.findIndex(
    (item) => item.type === "user_message" && item.text === "use the fork's work",
  );
  assert.ok(marker !== -1 && message === marker + 1, "the merge-back item shows just before the message");
  assert.equal(visible[marker].title, "Merge-back context");
  assert.equal(visible[marker].summary, handoff.summaryText);
  // The history goes to the provider, never into the user's message.
  assert.ok(!visible.some((item) => item.type === "user_message" && item.text.includes("Context handoff (")));
});

// Pull request links: T3's GitHub keys, a stack tombstone lifted by hand.
check("pull requests and issues: link, unlink and relink as T3 writes them", () => {
  const followed = followThread(exported.pullRequestLinkItems);
  assert.equal(followed.status, "live");
  const kinds = exported.pullRequestLinkItems
    .filter((item) => item.event)
    .map((item) => item.event.type);
  assert.deepEqual(kinds.slice(-10, -4), Array(6).fill("thread.pull-request-synced"));
  assert.deepEqual(kinds.slice(-4), Array(4).fill("thread.issue-synced"));
  // A link that is already there keeps the thread's time, so the sidebar does not move it.
  const issueEvents = exported.pullRequestLinkItems.filter((item) => item.event?.type === "thread.issue-synced");
  assert.equal(issueEvents[1].event.payload.updatedAt, issueEvents[0].event.payload.updatedAt);
  // Issue links as T3's decider keeps them: one #12 (host in lower case), #13 gone.
  assert.deepEqual(
    followed.projection.thread.issues.map((link) => [link.host, link.scope, link.key, link.displayKey, link.source]),
    [["github.com", "o/r", "12", "#12", "agent"]],
  );
  const links = followed.projection.thread.pullRequests.map((link) => ({
    host: link.host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
  }));
  assert.deepEqual(links, [
    { host: "github.com", repository: "o/r", number: 4, url: "https://github.com/O/R/pull/4", source: "manual" },
    { host: "github.com", repository: "o/r", number: 9, url: "https://github.com/o/r/pull/9", source: "manual" },
  ]);
  // The link sweep's writes reach the client: #4's snapshot and the branch's pull request.
  const [first] = followed.projection.thread.pullRequests;
  assert.equal(first.snapshot.title, "Fix the chip");
  assert.equal(first.snapshot.checksState, "failing");
  assert.equal(first.snapshot.reviewDecision, "review-required");
  assert.equal(followed.projection.thread.branchPullRequest.number, 4);
});

check("batch threads: creation appears in the parent timeline and keeps sender provenance", () => {
  const parent = followThread(exported.createdThreadItems);
  assert.equal(parent.status,"live");
  const created = parent.projection.turnItems.find((item) => item.type === "thread_created");
  assert.equal(created.targetThreadId,"thread-created");
  assert.equal(created.targetRunId,"run:thread-created:1");
  assert.equal(created.status,"completed");
  const child = decodeDetailSnapshot(exported.createdThreadSnapshot).projection;
  assert.equal(child.thread.lineage.parentThreadId,null);
  assert.equal(child.messages[0].senderThreadId,"thread-1");
  assert.equal(child.messages[0].creationSource,"mcp");
});

console.log(`\n${checks} checks passed against the client's own decoders and reducers.`);
