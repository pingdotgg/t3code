import { it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, vi } from "vite-plus/test";

import type * as EventStore from "./EventStore.ts";
import { nativeStorageFolders } from "./NativeStorageFolder.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const row = ProviderThreadId.make("provider-thread:claude");
const otherRow = ProviderThreadId.make("provider-thread:other");
const codexRow = ProviderThreadId.make("provider-thread:codex");

const run = (ordinal: number, cwd?: string) => ({
  id: RunId.make(`run:${ordinal}`),
  ordinal,
  ...(cwd === undefined ? {} : { cwd }),
});
const attempt = (ordinal: number, nativeThreadId?: string, providerThreadId = row) => ({
  runId: RunId.make(`run:${ordinal}`),
  providerThreadId,
  ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
});
const rootScope = (ordinal: number, cwd: string, providerThreadId = row) => ({
  kind: "root_run" as const,
  runId: RunId.make(`run:${ordinal}`),
  providerThreadId,
  cwd,
});
const providerThread = (nativeId: string, id = row, recorded?: string) =>
  ({
    id,
    driver: claude,
    nativeThreadRef: { driver: claude, nativeId, strength: "strong" },
    ...(recorded === undefined ? {} : { nativeStorageFolder: recorded }),
  }) as OrchestrationV2ProviderThread;

const runs = [run(4, "/repo/d"), run(1), run(3, "/repo/b"), run(2)];
const events = [
  rootScope(4, "/repo/d"),
  rootScope(3, "/repo/queued"),
  rootScope(2, "/repo/a"),
  rootScope(1, "/repo/other-queued", otherRow),
  rootScope(1, "/repo/other", otherRow),
  { kind: "subagent" as const, runId: RunId.make("run:1"), providerThreadId: row, cwd: "/repo/x" },
].map((payload) => ({ event: { type: "checkpoint-scope.created", payload } }) as never);

it.effect.each([
  {
    name: "uses the cwd of the earliest run that sent to the session, not the row's earliest run",
    providerThreads: [providerThread("b")],
    attempts: [attempt(4, "b"), attempt(2, "a"), attempt(3, "b"), attempt(1, "a")],
    folders: [[row, "/repo/b"]],
    reads: 0,
  },
  {
    name: "falls back to the earliest run's latest scope event when its runs have no cwd",
    providerThreads: [providerThread("a")],
    attempts: [attempt(2, "a"), attempt(1, "a", otherRow)],
    folders: [[row, "/repo/other"]],
    reads: 1,
  },
  {
    name: "keeps the earliest session run's scope event when only a later run recorded a cwd",
    providerThreads: [providerThread("a")],
    attempts: [attempt(1, "a"), attempt(3, "a")],
    folders: [[row, "/repo/other"]],
    reads: 1,
  },
  {
    name: "ignores later runs' scope events when the earliest session run's own is pruned",
    providerThreads: [providerThread("a")],
    attempts: [attempt(1, "a"), attempt(3, "a")],
    events: events.slice(0, 3),
    folders: [],
    reads: 1,
  },
  {
    name: "uses the row's earliest surviving scope event when its attempts predate nativeThreadId",
    providerThreads: [providerThread("a")],
    attempts: [attempt(1, undefined, otherRow), attempt(2), attempt(3), attempt(4)],
    folders: [[row, "/repo/a"]],
    reads: 1,
  },
  {
    name: "takes a recorded folder without reading scope events",
    providerThreads: [providerThread("b", row, "/repo/b")],
    attempts: [attempt(2), attempt(3)],
    folders: [[row, "/repo/b"]],
    reads: 0,
  },
  {
    name: "reads scope events once for the undecided Claude rows, none for a session that never ran",
    providerThreads: [
      providerThread("a"),
      providerThread("a", otherRow),
      { ...providerThread("a", codexRow), driver: ProviderDriverKind.make("codex") },
      providerThread("c", ProviderThreadId.make("provider-thread:never-ran")),
    ],
    attempts: [attempt(2), attempt(3)],
    folders: [
      [row, "/repo/a"],
      [otherRow, "/repo/other"],
    ],
    reads: 1,
  },
])("$name", ({ providerThreads, attempts, folders, reads, events: rowEvents = events }) =>
  Effect.gen(function* () {
    const read = vi.fn<EventStore.EventStoreV2Shape["read"]>(() => Stream.fromIterable(rowEvents));
    const resolved = yield* nativeStorageFolders({ read }, ThreadId.make("thread"), {
      runs,
      attempts,
      providerThreads,
    });
    expect([...resolved]).toEqual(folders);
    expect(read).toHaveBeenCalledTimes(reads);
  }),
);
