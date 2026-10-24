import {
  MessageId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  announcedRun,
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "./threadActivityAnnouncement";

const firstRun = RunId.make("run-1");
const secondRun = RunId.make("run-2");

const idle = (
  runId: RunId | null,
  runStatus: ThreadActivitySnapshot["runStatus"],
): ThreadActivitySnapshot => ({ status: "idle", requestId: null, runId, runStatus });
const busy = (
  status: Exclude<ThreadActivitySnapshot["status"], "idle"> = "working",
  runId: RunId | null = secondRun,
  runStatus: ThreadActivitySnapshot["runStatus"] = "running",
  requestId: string | null = status === "working" ? null : "request-1",
): ThreadActivitySnapshot => ({ status, requestId, runId, runStatus });

function speak(snapshots: ReadonlyArray<ThreadActivitySnapshot>) {
  let memory: ThreadAnnouncementMemory | null = null;
  const spoken: string[] = [];
  for (const snapshot of snapshots) {
    const result = nextThreadAnnouncement(memory, snapshot);
    memory = result.memory;
    if (result.announcement !== null) spoken.push(result.announcement);
  }
  return spoken;
}

describe("nextThreadAnnouncement", () => {
  it("follows a turn from start to finish", () => {
    expect(
      speak([idle(firstRun, "completed"), busy(), busy(), idle(secondRun, "completed")]),
    ).toEqual(["Working", "Done"]);
  });

  it("says Working once when a send looks idle before its run appears", () => {
    expect(
      speak([idle(null, null), busy(), idle(null, null), busy(), idle(secondRun, "completed")]),
    ).toEqual(["Working", "Done"]);
  });

  it("announces a queued message that starts as the last turn ends", () => {
    const thirdRun = RunId.make("run-3");
    expect(
      speak([
        idle(firstRun, "completed"),
        busy("working", firstRun, "completed"),
        busy(),
        busy("working", secondRun, "completed"),
        busy("working", thirdRun, "starting"),
        idle(thirdRun, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
    // The last turn's run is still settling when the follow-up is sent.
    expect(
      speak([
        idle(firstRun, "running"),
        busy("working", firstRun, "running"),
        busy("working", secondRun, "starting"),
      ]),
    ).toEqual(["Working"]);
    expect(
      speak([
        idle(firstRun, "running"),
        busy("working", firstRun, "running"),
        idle(firstRun, "completed"),
        busy("working", secondRun, "starting"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Done"]);
    expect(
      speak([
        busy("working", firstRun, "running"),
        idle(firstRun, "running"),
        busy("working", firstRun, "running"),
        busy("working", secondRun, "starting"),
      ]),
    ).toEqual(["Working"]);
  });

  it("treats a run that starts while the thread looks idle as the next turn", () => {
    const thirdRun = RunId.make("run-3");
    // A resume or a turn started from another device.
    expect(
      speak([
        idle(firstRun, "completed"),
        idle(secondRun, "starting"),
        busy("working", secondRun, "running"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Done"]);
    // A queued message waiting to start after the last turn.
    expect(
      speak([
        idle(firstRun, "completed"),
        busy(),
        idle(thirdRun, "queued"),
        idle(thirdRun, "starting"),
        busy("working", thirdRun, "running"),
        idle(thirdRun, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
  });

  it("stays silent when a thread opens mid-turn or after one", () => {
    expect(speak([idle(firstRun, "completed"), idle(firstRun, "completed")])).toEqual([]);
    expect(speak([busy(), busy()])).toEqual([]);
  });

  it("announces the end of a turn that was already running when the thread opened", () => {
    expect(speak([busy(), idle(secondRun, "failed")])).toEqual(["Failed"]);
  });

  it("says how the turn ended when a queued message was cancelled before it started", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"]) =>
      ({
        id,
        threadId: ThreadId.make("thread-1"),
        ordinal,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: status === "cancelled" ? null : now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      }) satisfies OrchestrationV2Run;
    const cancelledRun = RunId.make("run-3");
    const ended = announcedRun({ runId: cancelledRun, status: "cancelled", startedAt: null }, [
      run(secondRun, 1, "completed"),
      run(cancelledRun, 2, "cancelled"),
    ]);
    expect(speak([busy(), idle(ended?.runId ?? null, ended?.status ?? null)])).toEqual(["Done"]);
  });

  it("waits for the run to settle before announcing how the turn ended", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        busy(),
        idle(secondRun, "running"),
        idle(secondRun, "interrupted"),
      ]),
    ).toEqual(["Working", "Stopped"]);
  });

  it("does not report the previous turn's ending when work stops before a new run exists", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        busy("working", firstRun, "completed"),
        idle(firstRun, "completed"),
        busy(),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
    // The previous run finished while this client looked idle.
    expect(
      speak([
        idle(firstRun, "completed"),
        idle(secondRun, "completed"),
        busy("working", secondRun, "completed"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working"]);
  });

  it("lets the next turn start after one is rolled back", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        busy(),
        idle(secondRun, "rolled_back"),
        busy("working", RunId.make("run-3")),
      ]),
    ).toEqual(["Working", "Working"]);
  });

  it("announces each request once without repeating that work resumed", () => {
    expect(
      speak([
        busy(),
        busy("approval"),
        busy("approval"),
        busy(),
        busy("input"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Needs approval", "Needs your input", "Done"]);
  });

  it("announces a second request of the same kind once the first is answered", () => {
    expect(
      speak([
        busy(),
        busy("approval", secondRun, "running", "request-1"),
        busy("approval", secondRun, "running", "request-2"),
      ]),
    ).toEqual(["Needs approval", "Needs approval"]);
  });
});
