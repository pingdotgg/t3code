import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcess, spawn } from "node:child_process";

import { ThreadId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { makeCursorAdapterLive } from "./CursorAdapter.ts";

function makeFakeSpawn(): typeof spawn {
  return ((command: string) => {
    assert.equal(command.includes("cursor"), true);

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null;
    child.kill = () => true;

    queueMicrotask(() => {
      stdout.write('{"type":"assistant","message":{"content":[{"text":"Hello from Cursor"}]}}\n');
      stdout.write('{"type":"result","result":"Hello from Cursor","session_id":"sess-cursor-1"}\n');
      stdout.end();
      child.emit("close", 0, null);
    });

    return child;
  }) as typeof spawn;
}

const layer = it.layer(makeCursorAdapterLive({ spawnProcess: makeFakeSpawn() }));

layer("CursorAdapterLive", (it) => {
  it.effect("starts a session and maps stream-json output into runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const threadId = ThreadId.makeUnsafe("thread-cursor");

      const session = yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        model: "gpt-5",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "cursor");
      assert.equal(session.status, "ready");

      yield* adapter.sendTurn({
        threadId,
        input: "Say hello",
        interactionMode: "default",
      });

      const events = yield* Stream.take(adapter.streamEvents, 5).pipe(Stream.runCollect);
      const eventTypes = Array.from(events).map((event) => event.type);
      assert.deepEqual(eventTypes, [
        "session.started",
        "session.state.changed",
        "turn.started",
        "content.delta",
        "turn.completed",
      ]);
    }),
  );
});
