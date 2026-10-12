import { assert, describe, it } from "@effect/vitest";
import {
  CONTRIBUTION_STATUS_MAX_ITEMS,
  CONTRIBUTION_STATUS_MAX_ITEMS_PER_SOURCE,
  CONTRIBUTION_STATUS_MAX_THREADS,
  type ContributionStatusSource,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ContributionStatusStore from "./ContributionStatusStore.ts";

const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

const source = (session: string): ContributionStatusSource => ({
  kind: "provider-session",
  providerSessionId: ProviderSessionId.make(session),
  providerInstanceId: ProviderInstanceId.make("pi"),
  driver: ProviderDriverKind.make("pi"),
});

/** Opens a handle in its own scope so a test can end that producer on demand. */
const openHandle = Effect.fn("openHandle")(function* (
  store: ContributionStatusStore.ContributionStatusStoreShape,
  session: string,
  threadId: ThreadId | null,
) {
  const scope = yield* Scope.make();
  const handle = yield* store.openSource(source(session)).pipe(Scope.provide(scope));
  yield* handle.bindThread(threadId);
  return { handle, close: Scope.close(scope, Exit.void) };
});

const itemsByThread = (store: ContributionStatusStore.ContributionStatusStoreShape) =>
  Effect.map(store.snapshot, (snapshot) =>
    Object.fromEntries(
      snapshot.entries.map((entry) => [
        entry.threadId,
        entry.items.map((item) => `${item.key}=${item.text}`),
      ]),
    ),
  );

describe("ContributionStatusStore", () => {
  it.effect("sets, replaces, and clears statuses as plain single-line text", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const { handle } = yield* openHandle(store, "session-1", THREAD_A);

      yield* handle.set({ key: "mode", text: "\u001b[32m● plan\u001b[39m\nmode" });
      yield* handle.set({ key: "branch", text: "main" });
      assert.deepStrictEqual(yield* itemsByThread(store), {
        [THREAD_A]: ["branch=main", "mode=● plan mode"],
      });

      yield* handle.set({ key: "mode", text: "build" });
      yield* handle.clear("branch");
      assert.deepStrictEqual(yield* itemsByThread(store), { [THREAD_A]: ["mode=build"] });

      // A lone surrogate would encode as a six-byte JSON escape; it becomes U+FFFD.
      yield* handle.set({ key: "lone", text: "a\uD800b", tooltip: "\uDC00" });
      const lone = (yield* store.snapshot).entries[0]?.items.find((item) => item.key === "lone");
      assert.deepStrictEqual(lone, { key: "lone", text: "a\uFFFDb", tooltip: "\uFFFD" });

      yield* handle.set({ key: "mode", text: " \t " });
      yield* handle.clear("lone");
      assert.deepStrictEqual(yield* itemsByThread(store), {});
    }),
  );

  it.effect("bounds keys, text, and items per source", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const { handle } = yield* openHandle(store, "session-1", THREAD_A);

      for (let index = 0; index < 9; index += 1) {
        yield* handle.set({ key: `k${index}`, text: "on" });
      }
      yield* handle.set({ key: "k0", text: `${"a".repeat(78)}😀tail` });

      const [entry] = (yield* store.snapshot).entries;
      assert.strictEqual(entry?.items.length, 8);
      assert.isFalse(entry?.items.some((item) => item.key === "k8"));
      // The emoji would straddle the limit, so it is dropped rather than split.
      assert.strictEqual(entry?.items[0]?.text, `${"a".repeat(78)}…`);
    }),
  );

  it.effect("treats keys as identities that never collide", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const { handle } = yield* openHandle(store, "session-1", THREAD_A);
      const prefix = "x".repeat(63);

      yield* handle.set({ key: `${prefix}A`, text: "first" });
      yield* handle.set({ key: `${prefix}B`, text: "second" });
      yield* handle.set({ key: "a b", text: "spaced" });
      yield* handle.set({ key: "a  b", text: "double spaced" });
      // Overlong or control-character keys are rejected, never rewritten into another key.
      yield* handle.set({ key: `${prefix}AB`, text: "overlong" });
      yield* handle.set({ key: "a\nb", text: "control" });
      yield* handle.set({ key: "a\uD800", text: "lone surrogate" });
      assert.deepStrictEqual(yield* itemsByThread(store), {
        [THREAD_A]: ["a  b=double spaced", "a b=spaced", `${prefix}A=first`, `${prefix}B=second`],
      });

      // Clearing applies the same rule, so it cannot remove a neighbouring key.
      yield* handle.clear(`${prefix}AB`);
      yield* handle.clear("a\tb");
      yield* handle.clear("a\uD800");
      yield* handle.clear(`${prefix}A`);
      yield* handle.clear("a b");
      assert.deepStrictEqual(yield* itemsByThread(store), {
        [THREAD_A]: ["a  b=double spaced", `${prefix}B=second`],
      });
    }),
  );

  it.effect("clears a producer's statuses when its scope closes and ignores it afterwards", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const { handle, close } = yield* openHandle(store, "session-1", THREAD_A);
      yield* handle.set({ key: "mode", text: "plan" });

      yield* close;
      yield* handle.set({ key: "mode", text: "late" });
      yield* handle.bindThread(THREAD_B);

      assert.deepStrictEqual(yield* itemsByThread(store), {});
    }),
  );

  it.effect("moves a producer between threads and keeps items when rebinding its own thread", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const { handle } = yield* openHandle(store, "session-1", THREAD_A);
      yield* handle.set({ key: "mode", text: "plan" });

      yield* handle.bindThread(THREAD_A);
      assert.deepStrictEqual(yield* itemsByThread(store), { [THREAD_A]: ["mode=plan"] });

      yield* handle.bindThread(THREAD_B);
      yield* handle.set({ key: "mode", text: "fork" });
      assert.deepStrictEqual(yield* itemsByThread(store), { [THREAD_B]: ["mode=fork"] });
    }),
  );

  it.effect("rejects a replaced producer so late updates cannot touch the replacement", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const old = yield* openHandle(store, "session-old", THREAD_A);
      yield* old.handle.set({ key: "mode", text: "old" });

      const replacement = yield* openHandle(store, "session-new", THREAD_A);
      assert.deepStrictEqual(yield* itemsByThread(store), {});
      yield* replacement.handle.set({ key: "mode", text: "new" });

      yield* old.handle.set({ key: "mode", text: "stale" });
      yield* old.handle.clear("mode");
      yield* old.handle.clearAll;
      yield* old.close;

      const snapshot = yield* store.snapshot;
      assert.deepStrictEqual(yield* itemsByThread(store), { [THREAD_A]: ["mode=new"] });
      assert.strictEqual(
        snapshot.entries[0]?.source.providerSessionId,
        ProviderSessionId.make("session-new"),
      );
    }),
  );

  it.effect("gives each subscriber the current state, then only the latest change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ContributionStatusStore.make();
        const { handle } = yield* openHandle(store, "session-1", THREAD_A);
        yield* handle.set({ key: "mode", text: "plan" });

        const subscription = yield* store.subscribe;
        assert.deepStrictEqual(
          subscription.latest.entries.map((entry) => entry.threadId),
          [THREAD_A],
        );

        yield* handle.set({ key: "mode", text: "build" });
        yield* handle.set({ key: "mode", text: "review" });
        yield* handle.set({ key: "turn", text: "3" });
        const next = yield* Stream.runHead(subscription.changes);
        assert.deepStrictEqual(
          next._tag === "Some" ? next.value.entries[0]?.items.map((item) => item.text) : [],
          ["review", "3"],
        );

        // A reconnect is a fresh subscription; its first frame is the current state.
        const reconnect = yield* store.subscribe;
        assert.deepStrictEqual(reconnect.latest, yield* store.snapshot);
      }),
    ),
  );

  it.effect("caps threads showing a status without counting silent producers", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const max = CONTRIBUTION_STATUS_MAX_THREADS;
      // More bound producers than the cap that never set anything take no capacity.
      for (let index = 0; index <= max; index += 1) {
        yield* openHandle(store, `silent-${index}`, ThreadId.make(`silent-${index}`));
      }
      const visible = [];
      for (let index = 0; index < max; index += 1) {
        const opened = yield* openHandle(store, `visible-${index}`, ThreadId.make(`t-${index}`));
        yield* opened.handle.set({ key: "mode", text: "on" });
        visible.push(opened.handle);
      }
      assert.strictEqual((yield* store.snapshot).entries.length, max);

      const late = yield* openHandle(store, "late", ThreadId.make("late"));
      yield* late.handle.set({ key: "mode", text: "rejected" });
      assert.isUndefined(
        (yield* store.snapshot).entries.find((entry) => entry.threadId === "late"),
      );

      // Clearing a thread's last item returns its capacity, and the rejected producer's next set lands.
      yield* visible[0]!.clear("mode");
      yield* late.handle.set({ key: "mode", text: "admitted" });
      const snapshot = yield* store.snapshot;
      assert.strictEqual(snapshot.entries.length, max);
      assert.deepStrictEqual(snapshot.entries.find((entry) => entry.threadId === "late")?.items, [
        { key: "mode", text: "admitted" },
      ]);
      // A thread already showing a status can still replace it at the cap.
      yield* visible[1]!.set({ key: "mode", text: "replaced" });
      assert.strictEqual(
        (yield* store.snapshot).entries.find((entry) => entry.threadId === "t-1")?.items[0]?.text,
        "replaced",
      );
    }),
  );

  it.effect("orders entries by thread and caps the items in one snapshot", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const fullThreads = CONTRIBUTION_STATUS_MAX_ITEMS / CONTRIBUTION_STATUS_MAX_ITEMS_PER_SOURCE;
      const handles = [];
      // Bind in reverse so the snapshot order cannot come from insertion order.
      for (let index = fullThreads; index >= 0; index -= 1) {
        const opened = yield* openHandle(store, `s-${index}`, ThreadId.make(`t-${index}`));
        handles[index] = opened.handle;
      }
      for (let index = 0; index <= fullThreads; index += 1) {
        for (let item = 0; item < CONTRIBUTION_STATUS_MAX_ITEMS_PER_SOURCE; item += 1) {
          yield* handles[index]!.set({ key: `k${item}`, text: "on" });
        }
      }
      const snapshot = yield* store.snapshot;
      const threadIds = snapshot.entries.map((entry) => entry.threadId);
      assert.deepStrictEqual(threadIds, threadIds.toSorted());
      assert.strictEqual(threadIds.length, fullThreads);
      assert.notInclude(threadIds, ThreadId.make(`t-${fullThreads}`));
      assert.strictEqual(
        snapshot.entries.reduce((total, entry) => total + entry.items.length, 0),
        CONTRIBUTION_STATUS_MAX_ITEMS,
      );

      yield* handles[0]!.clear("k0");
      yield* handles[fullThreads]!.set({ key: "k0", text: "admitted" });
      assert.include(
        (yield* store.snapshot).entries.map((entry) => entry.threadId),
        ThreadId.make(`t-${fullThreads}`),
      );
    }),
  );
});
