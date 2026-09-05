// @effect-diagnostics nodeBuiltinImport:off - exercise the native registration boundary and atomic HEAD replacement.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitHeadWatcher from "./GitHeadWatcher.ts";

class TestWatcher extends NodeEvents.EventEmitter implements NodeFS.FSWatcher {
  closeCalls = 0;
  close() {
    this.closeCalls += 1;
    this.emit("close");
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

const watch = vi.fn<Parameters<typeof GitHeadWatcher.make>[0]>();
beforeEach(() => {
  watch.mockReset();
});

it.effect("registers listeners before returning and buffers events before consumption", () =>
  Effect.gen(function* () {
    const native = new TestWatcher();
    watch.mockReturnValue(native);
    const scope = yield* Scope.make();
    const events = yield* GitHeadWatcher.make(watch)
      .acquire("/repo/.git")
      .pipe(Scope.provide(scope));
    assert.deepStrictEqual(watch.mock.calls[0]?.[1], { recursive: false });
    assert.equal(native.listenerCount("error"), 1);
    assert.equal(native.listenerCount("close"), 1);
    const callback = watch.mock.calls[0]?.[2];
    assert.isFunction(callback);
    callback?.("rename", "HEAD");
    callback?.("change", "HEAD");
    callback?.("change", null);
    assert.deepStrictEqual(yield* events.pipe(Stream.take(3), Stream.runCollect), [
      "HEAD",
      "HEAD",
      null,
    ]);
    assert.equal(native.closeCalls, 0);
    yield* Scope.close(scope, Exit.void);
    assert.equal(native.closeCalls, 1);
  }),
);

it.effect("reports a native registration error as a typed watch failure", () =>
  Effect.gen(function* () {
    const cause = new Error("watch limit reached");
    watch.mockImplementation(() => {
      throw cause;
    });
    const failure = yield* GitHeadWatcher.make(watch)
      .acquire("/repo/.git")
      .pipe(Effect.scoped, Effect.flip);
    assert.equal(failure.reason.module, "FileSystem");
    assert.equal(failure.reason.method, "watch");
    assert.strictEqual(failure.cause, cause);
  }),
);

it.effect("closes a failed watcher before a fresh registration is acquired", () =>
  Effect.gen(function* () {
    const first = new TestWatcher();
    const second = new TestWatcher();
    watch.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = GitHeadWatcher.make(watch);
    const cause = new Error("native watcher failed");
    const failure = yield* Effect.gen(function* () {
      const events = yield* service.acquire("/repo/.git");
      first.emit("error", cause);
      return yield* Stream.runDrain(events);
    }).pipe(Effect.scoped, Effect.flip);
    assert.strictEqual(failure.cause, cause);
    assert.equal(first.closeCalls, 1);

    yield* Effect.gen(function* () {
      yield* service.acquire("/repo/.git").pipe(Effect.asVoid);
      assert.equal(first.closeCalls, 1);
      assert.equal(second.closeCalls, 0);
    }).pipe(Effect.scoped);
    assert.equal(second.closeCalls, 1);
  }),
);

it.effect("ends the event stream when the native watcher closes", () =>
  Effect.gen(function* () {
    const native = new TestWatcher();
    watch.mockReturnValue(native);
    yield* Effect.gen(function* () {
      const events = yield* GitHeadWatcher.make(watch).acquire("/repo/.git");
      native.emit("close");
      assert.deepStrictEqual(yield* Stream.runCollect(events), []);
    }).pipe(Effect.scoped);
    assert.equal(native.closeCalls, 1);
  }),
);

it.effect("closes the native watcher when its consumer is interrupted", () =>
  Effect.gen(function* () {
    const native = new TestWatcher();
    watch.mockReturnValue(native);
    const acquired = yield* Deferred.make<void>();
    const consumer = yield* Effect.gen(function* () {
      const events = yield* GitHeadWatcher.make(watch).acquire("/repo/.git");
      yield* Deferred.succeed(acquired, undefined);
      yield* Stream.runDrain(events);
    }).pipe(Effect.scoped, Effect.forkScoped);
    yield* Deferred.await(acquired);
    yield* Fiber.interrupt(consumer);
    assert.equal(native.closeCalls, 1);
  }),
);

it.live("observes an atomic HEAD replacement made immediately after native acquisition", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-head-watch-" });
    yield* fs.writeFileString(`${directory}/HEAD`, "ref: refs/heads/main\n");
    const events = yield* GitHeadWatcher.make(NodeFS.watch).acquire(directory);
    yield* fs.writeFileString(`${directory}/HEAD.lock`, "ref: refs/heads/feature/watch\n");
    yield* fs.rename(`${directory}/HEAD.lock`, `${directory}/HEAD`);
    const changed = yield* events.pipe(
      Stream.filter((filename) => filename === "HEAD"),
      Stream.runHead,
    );
    assert.deepStrictEqual(changed, Option.some("HEAD"));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
