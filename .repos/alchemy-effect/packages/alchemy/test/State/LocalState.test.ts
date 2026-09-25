import { STATE_STORE_VERSION } from "@/State/HttpStateApi.ts";
import { makeLocalState } from "@/State/LocalState.ts";
import type { ResourceState } from "@/State/ResourceState.ts";
import { initialCwd } from "@/Util/Node.ts";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const resource = (
  fqn: string,
  attr: Record<string, unknown>,
  overrides?: Partial<ResourceState>,
): ResourceState =>
  ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr,
    ...overrides,
  }) as ResourceState;

/**
 * Absolute path into the store's on-disk layout (`.alchemy/state/...`).
 *
 * Anchored to `initialCwd` — the same anchor `makeLocalState` uses — instead
 * of a live `process.cwd()` read: another suite's in-process build (e.g. a
 * Waku source build) can transiently chdir the whole test process, and a
 * live read racing that window points at an unrelated (missing) tree.
 */
const statePath = (...segments: string[]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(initialCwd, ".alchemy", "state", ...segments);
  });

describe("makeLocalState", () => {
  it.effect("reads of absent state recover to empty results", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-test-absent";

      expect(
        yield* state.get({ stack, stage: "test", fqn: "nope" }),
      ).toBeUndefined();
      expect(yield* state.list({ stack, stage: "test" })).toEqual([]);
      expect(yield* state.listStages(stack)).toEqual([]);
      expect(yield* state.getOutput({ stack, stage: "test" })).toBeUndefined();
      expect(
        yield* state.getReplacedResources({ stack, stage: "test" }),
      ).toEqual([]);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("set/get roundtrip with list, listStacks and listStages", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-test-crud";
      const stage = "test";

      const plain = resource("resource-a", { value: "a" });
      // fqns contain `/` separators; the store must encode them into flat
      // file names and decode them back on list.
      const nested = resource("scope/nested/resource-b", { value: "b" });
      yield* state.set({ stack, stage, fqn: plain.fqn, value: plain });
      yield* state.set({ stack, stage, fqn: nested.fqn, value: nested });

      expect(yield* state.get({ stack, stage, fqn: plain.fqn })).toEqual(plain);
      expect(yield* state.get({ stack, stage, fqn: nested.fqn })).toEqual(
        nested,
      );
      expect((yield* state.list({ stack, stage })).toSorted()).toEqual([
        "resource-a",
        "scope/nested/resource-b",
      ]);
      expect(yield* state.listStacks()).toContain(stack);
      expect(yield* state.listStages(stack)).toEqual([stage]);

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("delete removes one resource without touching its siblings", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-test-delete";
      const stage = "test";
      const a = resource("resource-a", { value: "a" });
      const b = resource("resource-b", { value: "b" });
      yield* state.set({ stack, stage, fqn: a.fqn, value: a });
      yield* state.set({ stack, stage, fqn: b.fqn, value: b });

      yield* state.delete({ stack, stage, fqn: a.fqn });
      // deleting an already-deleted resource is not an error
      yield* state.delete({ stack, stage, fqn: a.fqn });

      expect(yield* state.get({ stack, stage, fqn: a.fqn })).toBeUndefined();
      expect(yield* state.get({ stack, stage, fqn: b.fqn })).toEqual(b);

      // `delete` only removes files, so the directory cache stays valid
      // and a re-set must persist.
      yield* state.set({ stack, stage, fqn: a.fqn, value: a });
      expect(yield* state.get({ stack, stage, fqn: a.fqn })).toEqual(a);

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("list excludes bookkeeping, in-flight and non-json files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* makeLocalState();
      const stack = "local-state-test-list-filter";
      const stage = "test";
      const a = resource("resource-a", { value: "a" });
      yield* state.set({ stack, stage, fqn: a.fqn, value: a });
      // writes `__stack_output__.json`, which must not surface as a resource
      yield* state.setOutput({ stack, stage, value: { out: true } });
      // a lingering writeAtomic temp file must not surface either
      const tmp = yield* statePath(stack, stage, "resource-a.json.123.tmp");
      yield* fs.writeFileString(tmp, "{}");

      expect(yield* state.list({ stack, stage })).toEqual(["resource-a"]);

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("get treats a zero-length state file as absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* makeLocalState();
      const stack = "local-state-test-empty-file";
      const stage = "test";
      const dir = yield* statePath(stack, stage);
      yield* fs.makeDirectory(dir, { recursive: true });
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(dir, "resource-a.json"), "");

      expect(
        yield* state.get({ stack, stage, fqn: "resource-a" }),
      ).toBeUndefined();

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("getReplacedResources returns only replaced resources", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-test-replaced";
      const stage = "test";
      const created = resource("resource-a", { value: "a" });
      const replaced = resource("resource-b", { value: "b" }, {
        status: "replaced",
        old: resource("resource-b", { value: "old" }),
        deleteFirst: false,
      } as Partial<ResourceState>);
      yield* state.set({ stack, stage, fqn: created.fqn, value: created });
      yield* state.set({ stack, stage, fqn: replaced.fqn, value: replaced });

      expect(yield* state.getReplacedResources({ stack, stage })).toEqual([
        replaced,
      ]);

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("setOutput/getOutput roundtrip", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-test-output";
      const stage = "test";
      const value = { url: "https://example.com", nested: { n: 1 } };
      yield* state.setOutput({ stack, stage, value });

      expect(yield* state.getOutput({ stack, stage })).toEqual(value);

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("set persists again after deleteStack removes the stage dir", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const key = {
        stack: "local-state-created-cache-test",
        stage: "test",
        fqn: "resource-a",
      };

      yield* state.set({ ...key, value: resource(key.fqn, { round: 1 }) });
      expect(yield* state.get(key)).toMatchObject({ attr: { round: 1 } });

      yield* state.deleteStack({ stack: key.stack });
      expect(yield* state.get(key)).toBeUndefined();

      // Before the `created`-cache invalidation, this write skipped
      // makeDirectory, failed with NotFound, and silently no-op'd.
      yield* state.set({ ...key, value: resource(key.fqn, { round: 2 }) });
      expect(yield* state.get(key)).toMatchObject({ attr: { round: 2 } });

      yield* state.deleteStack({ stack: key.stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("set persists again after a stage-scoped deleteStack", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const key = {
        stack: "local-state-created-cache-test-stage",
        stage: "test",
        fqn: "resource-a",
      };

      yield* state.set({ ...key, value: resource(key.fqn, { round: 1 }) });
      yield* state.deleteStack({ stack: key.stack, stage: key.stage });
      expect(yield* state.get(key)).toBeUndefined();

      yield* state.set({ ...key, value: resource(key.fqn, { round: 2 }) });
      expect(yield* state.get(key)).toMatchObject({ attr: { round: 2 } });

      yield* state.deleteStack({ stack: key.stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("whole-stack deleteStack invalidates every stage's cache", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-created-cache-test-multi";
      const fqn = "resource-a";

      // ensure both stage dirs are cached before the wholesale delete —
      // this exercises the prefix (not exact) match in the cache pruning
      yield* state.set({
        stack,
        stage: "a",
        fqn,
        value: resource(fqn, { round: 1 }),
      });
      yield* state.set({
        stack,
        stage: "b",
        fqn,
        value: resource(fqn, { round: 1 }),
      });
      yield* state.deleteStack({ stack });

      yield* state.set({
        stack,
        stage: "a",
        fqn,
        value: resource(fqn, { round: 2 }),
      });
      yield* state.set({
        stack,
        stage: "b",
        fqn,
        value: resource(fqn, { round: 2 }),
      });
      expect(yield* state.get({ stack, stage: "a", fqn })).toMatchObject({
        attr: { round: 2 },
      });
      expect(yield* state.get({ stack, stage: "b", fqn })).toMatchObject({
        attr: { round: 2 },
      });

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("stage-scoped deleteStack leaves the sibling stage intact", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-created-cache-test-sibling";
      const fqn = "resource-a";

      yield* state.set({
        stack,
        stage: "a",
        fqn,
        value: resource(fqn, { round: 1 }),
      });
      yield* state.set({
        stack,
        stage: "b",
        fqn,
        value: resource(fqn, { round: 1 }),
      });
      yield* state.deleteStack({ stack, stage: "a" });

      // sibling stage keeps its files and its still-valid cache entry
      expect(yield* state.get({ stack, stage: "b", fqn })).toMatchObject({
        attr: { round: 1 },
      });
      yield* state.set({
        stack,
        stage: "b",
        fqn,
        value: resource(fqn, { round: 2 }),
      });
      expect(yield* state.get({ stack, stage: "b", fqn })).toMatchObject({
        attr: { round: 2 },
      });

      // deleted stage is gone and re-settable
      expect(yield* state.get({ stack, stage: "a", fqn })).toBeUndefined();
      yield* state.set({
        stack,
        stage: "a",
        fqn,
        value: resource(fqn, { round: 2 }),
      });
      expect(yield* state.get({ stack, stage: "a", fqn })).toMatchObject({
        attr: { round: 2 },
      });

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("setOutput persists again after deleteStack", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-created-cache-test-output";
      const stage = "test";

      // setOutput goes through the same `ensure`/`created` cache as `set`
      yield* state.setOutput({ stack, stage, value: { round: 1 } });
      yield* state.deleteStack({ stack });
      expect(yield* state.getOutput({ stack, stage })).toBeUndefined();

      yield* state.setOutput({ stack, stage, value: { round: 2 } });
      expect(yield* state.getOutput({ stack, stage })).toEqual({ round: 2 });

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("getVersion returns the state store version", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      expect(yield* state.getVersion()).toBe(STATE_STORE_VERSION);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("deleteStack removes the stack from listings", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-test-delete-listing";
      yield* state.set({
        stack,
        stage: "test",
        fqn: "resource-a",
        value: resource("resource-a", {}),
      });

      yield* state.deleteStack({ stack });

      expect(yield* state.listStacks()).not.toContain(stack);
      expect(yield* state.listStages(stack)).toEqual([]);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("concurrent writes to the same resource never corrupt it", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const stack = "local-state-test-concurrent";
      const stage = "test";
      const fqn = "resource-a";

      const rounds = Array.from({ length: 20 }, (_, i) => i + 1);
      yield* Effect.all(
        rounds.map((round) =>
          state.set({ stack, stage, fqn, value: resource(fqn, { round }) }),
        ),
        { concurrency: "unbounded" },
      );

      // whichever write won, the file must parse as one complete state —
      // never a truncated interleaving (the writeAtomic guarantee)
      const final = (yield* state.get({ stack, stage, fqn })) as ResourceState;
      expect(rounds).toContain((final.attr as { round: number }).round);

      yield* state.deleteStack({ stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  describe("weird names", () => {
    it.effect("unicode, spaces and punctuation in every name position", () =>
      Effect.gen(function* () {
        const state = yield* makeLocalState();
        const stack = "local wéird 🚀..stack";
        const stage = "stage v1.2.3 ünïcode";
        const fqn = "my resource (α) #1 100%";
        const value = resource(fqn, { value: "weird" });

        yield* state.set({ stack, stage, fqn, value });
        expect(yield* state.get({ stack, stage, fqn })).toEqual(value);
        expect(yield* state.list({ stack, stage })).toEqual([fqn]);
        expect(yield* state.listStages(stack)).toEqual([stage]);

        yield* state.delete({ stack, stage, fqn });
        expect(yield* state.get({ stack, stage, fqn })).toBeUndefined();

        yield* state.deleteStack({ stack });
      }).pipe(Effect.provide(PlatformServices)),
    );

    it.effect("empty-string fqn roundtrips", () =>
      Effect.gen(function* () {
        const state = yield* makeLocalState();
        const stack = "local-state-test-empty-fqn";
        const stage = "test";
        const value = resource("", { empty: true });

        yield* state.set({ stack, stage, fqn: "", value });
        expect(yield* state.get({ stack, stage, fqn: "" })).toEqual(value);
        expect(yield* state.list({ stack, stage })).toEqual([""]);

        yield* state.deleteStack({ stack });
      }).pipe(Effect.provide(PlatformServices)),
    );

    it.effect("literal __ in a logical id: get roundtrips, list decodes", () =>
      Effect.gen(function* () {
        const state = yield* makeLocalState();
        const stack = "local-state-test-underscores";
        const stage = "test";
        const value = resource("foo__bar", { value: "u" });

        yield* state.set({ stack, stage, fqn: "foo__bar", value });
        expect(yield* state.get({ stack, stage, fqn: "foo__bar" })).toEqual(
          value,
        );
        // Known encoding collision: `/` is stored as `__`, so decodeFqn
        // cannot distinguish a literal `__` in a logical id from a
        // namespace separator. `list` reports this resource as "foo/bar".
        expect(yield* state.list({ stack, stage })).toEqual(["foo/bar"]);

        yield* state.deleteStack({ stack });
      }).pipe(Effect.provide(PlatformServices)),
    );

    it.effect("a resource named __stack_output__ never surfaces in list", () =>
      Effect.gen(function* () {
        const state = yield* makeLocalState();
        const stack = "local-state-test-output-clash";
        const stage = "test";
        const value = resource("__stack_output__", { value: "clash" });

        yield* state.set({ stack, stage, fqn: "__stack_output__", value });
        expect(yield* state.list({ stack, stage })).toEqual([]);

        yield* state.deleteStack({ stack });
      }).pipe(Effect.provide(PlatformServices)),
    );

    it.effect("overlong names fail with a typed StateStoreError", () =>
      Effect.gen(function* () {
        const state = yield* makeLocalState();
        const stack = "local-state-test-overlong";
        const stage = "test";
        // > 255 bytes exceeds the filename limit; only NotFound recovers,
        // so the platform error must surface as a typed StateStoreError
        // (never a silent no-op).
        const fqn = "x".repeat(300);

        const setError = yield* state
          .set({ stack, stage, fqn, value: resource(fqn, {}) })
          .pipe(Effect.flip);
        expect(setError._tag).toBe("StateStoreError");

        const getError = yield* state
          .get({ stack, stage, fqn })
          .pipe(Effect.flip);
        expect(getError._tag).toBe("StateStoreError");

        yield* state.deleteStack({ stack });
      }).pipe(Effect.provide(PlatformServices)),
    );
  });
});
