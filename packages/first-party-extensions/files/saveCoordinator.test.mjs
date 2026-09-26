import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { FileEditCoordinator } from "./saveCoordinator.ts";

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);
const REV_C = "c".repeat(64);

function harness(overrides = {}) {
  const calls = [];
  const confirmed = [];
  const states = [];
  const persist =
    overrides.persist ??
    ((contents, expectedRevision) => {
      calls.push({ contents, expectedRevision });
      return Promise.resolve({ kind: "saved", revision: REV_B });
    });
  const coordinator = new FileEditCoordinator({
    debounceMs: 500,
    persist,
    onConfirmed: (contents, revision) => confirmed.push({ contents, revision }),
    onStateChange: (state) => states.push(state.kind),
    ...overrides.options,
  });
  return { calls, confirmed, states, coordinator };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

NodeTest.describe("FileEditCoordinator", () => {
  NodeTest.it("debounces edits and persists only the latest contents", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { calls, confirmed, states, coordinator } = harness();
    coordinator.seed(REV_A, "base");

    coordinator.change("first");
    t.mock.timers.tick(300);
    coordinator.change("latest");
    t.mock.timers.tick(499);
    NodeAssert.equal(calls.length, 0);

    t.mock.timers.tick(1);
    await Promise.resolve();
    NodeAssert.equal(calls.length, 1);
    NodeAssert.deepEqual(calls[0], { contents: "latest", expectedRevision: REV_A });
    NodeAssert.deepEqual(confirmed, [{ contents: "latest", revision: REV_B }]);
    NodeAssert.equal(coordinator.state().kind, "saved");
    NodeAssert.deepEqual(states, ["clean", "dirty", "dirty", "saving", "saved"]);
  });

  NodeTest.it(
    "serializes writes: an edit during a write persists after the remaining debounce",
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const first = deferred();
      const calls = [];
      let n = 0;
      const { coordinator } = harness({
        persist: (contents, expectedRevision) => {
          calls.push({ contents, expectedRevision });
          return ++n === 1 ? first.promise : Promise.resolve({ kind: "saved", revision: REV_C });
        },
      });
      coordinator.seed(REV_A, "base");

      coordinator.change("first");
      t.mock.timers.tick(500);
      NodeAssert.equal(coordinator.state().kind, "saving");
      coordinator.change("latest");
      t.mock.timers.tick(500);
      NodeAssert.equal(calls.length, 1, "second write must wait for the first");

      first.resolve({ kind: "saved", revision: REV_B });
      await Promise.resolve();
      NodeAssert.equal(calls.length, 1, "follow-up waits out the debounce remainder");
      t.mock.timers.tick(500);
      await Promise.resolve();
      NodeAssert.equal(calls.length, 2);
      NodeAssert.deepEqual(calls[1], { contents: "latest", expectedRevision: REV_B });
      NodeAssert.equal(coordinator.state().kind, "saved");
    },
  );

  NodeTest.it("conflict on a stale revision halts autosave but keeps buffered edits", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { calls, coordinator } = harness({
      persist: (contents, expectedRevision) => {
        calls.push({ contents, expectedRevision });
        return Promise.resolve({ kind: "conflict" });
      },
    });
    coordinator.seed(REV_A, "base");
    coordinator.change("edit");
    t.mock.timers.tick(500);
    await Promise.resolve();
    NodeAssert.equal(coordinator.state().kind, "conflict");

    // Typing on a conflicted buffer keeps the edits but never writes.
    coordinator.change("more edits");
    t.mock.timers.tick(10_000);
    await Promise.resolve();
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(coordinator.contents(), "more edits");
    NodeAssert.equal(coordinator.state().kind, "conflict");
  });

  NodeTest.it(
    "forcePersist writes the buffered contents over the fresh remote revision",
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const calls = [];
      const { coordinator } = harness({
        persist: (contents, expectedRevision) => {
          calls.push({ contents, expectedRevision });
          return Promise.resolve(
            calls.length === 1 ? { kind: "conflict" } : { kind: "saved", revision: REV_C },
          );
        },
      });
      coordinator.seed(REV_A, "base");
      coordinator.change("mine");
      t.mock.timers.tick(500);
      await Promise.resolve();
      NodeAssert.equal(coordinator.state().kind, "conflict");

      coordinator.forcePersist(REV_B);
      await Promise.resolve();
      NodeAssert.equal(calls.length, 2);
      NodeAssert.deepEqual(calls[1], { contents: "mine", expectedRevision: REV_B });
      NodeAssert.equal(coordinator.state().kind, "saved");
    },
  );

  NodeTest.it("adoptRemote discards local edits and adopts the remote file", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { calls, coordinator } = harness({
      persist: () => {
        calls.push(1);
        return Promise.resolve({ kind: "conflict" });
      },
    });
    coordinator.seed(REV_A, "base");
    coordinator.change("mine");
    t.mock.timers.tick(500);
    await Promise.resolve();

    coordinator.adoptRemote("remote contents", REV_C);
    NodeAssert.equal(coordinator.state().kind, "clean");
    NodeAssert.equal(coordinator.contents(), "remote contents");
    t.mock.timers.tick(10_000);
    NodeAssert.equal(calls.length, 1);
  });

  NodeTest.it("noteRemoteRevision conflicts a dirty session and ignores a clean one", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const clean = harness();
    clean.coordinator.seed(REV_A, "base");
    clean.coordinator.noteRemoteRevision(REV_B);
    NodeAssert.equal(clean.coordinator.state().kind, "clean");

    const dirty = harness();
    dirty.coordinator.seed(REV_A, "base");
    dirty.coordinator.change("edit");
    dirty.coordinator.noteRemoteRevision(REV_B);
    NodeAssert.equal(dirty.coordinator.state().kind, "conflict");
    t.mock.timers.tick(10_000);
    NodeAssert.equal(dirty.calls.length, 0, "conflicted session never autosaves");
  });

  NodeTest.it("error keeps pending state and retry() re-persists", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const calls = [];
    const { coordinator } = harness({
      persist: (contents) => {
        calls.push(contents);
        return Promise.resolve(
          calls.length === 1
            ? { kind: "error", message: "workspace unavailable" }
            : { kind: "saved", revision: REV_B },
        );
      },
    });
    coordinator.seed(REV_A, "base");
    coordinator.change("edit");
    t.mock.timers.tick(500);
    await Promise.resolve();
    NodeAssert.deepEqual(coordinator.state(), {
      kind: "error",
      message: "workspace unavailable",
    });

    coordinator.retry();
    await Promise.resolve();
    NodeAssert.equal(calls.length, 2);
    NodeAssert.equal(coordinator.state().kind, "saved");
  });

  NodeTest.it("a failed write still retries edits that arrive during it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const first = deferred();
    const calls = [];
    const { coordinator } = harness({
      persist: (contents) => {
        calls.push(contents);
        return calls.length === 1
          ? first.promise
          : Promise.resolve({ kind: "saved", revision: REV_B });
      },
    });
    coordinator.seed(REV_A, "base");
    coordinator.change("first");
    t.mock.timers.tick(500);
    coordinator.change("latest");
    first.resolve({ kind: "error", message: "io" });
    await Promise.resolve();
    t.mock.timers.tick(500);
    await Promise.resolve();
    NodeAssert.deepEqual(calls, ["first", "latest"]);
    NodeAssert.equal(coordinator.state().kind, "saved");
  });

  NodeTest.it("dispose flushes pending edits immediately; cancel drops them", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const flushed = harness();
    flushed.coordinator.seed(REV_A, "base");
    flushed.coordinator.change("unsaved");
    flushed.coordinator.dispose();
    await Promise.resolve();
    NodeAssert.deepEqual(
      flushed.calls.map((c) => c.contents),
      ["unsaved"],
    );

    const cancelled = harness();
    cancelled.coordinator.seed(REV_A, "base");
    cancelled.coordinator.change("unsaved");
    cancelled.coordinator.cancel();
    t.mock.timers.tick(10_000);
    NodeAssert.equal(cancelled.calls.length, 0);
    cancelled.coordinator.change("after cancel");
    t.mock.timers.tick(10_000);
    NodeAssert.equal(cancelled.calls.length, 0, "cancelled session stays inert");
  });
});
