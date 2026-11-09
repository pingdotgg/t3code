import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";

import { MentionIndex, make, mentionIndexScopeKey, type MentionIndexRow } from "./MentionIndex.ts";

const projectId = ProjectId.make("project-1");

const row = (
  partial: Partial<MentionIndexRow> & Pick<MentionIndexRow, "itemKey" | "label">,
): MentionIndexRow => ({
  providerId: "pull-request",
  description: partial.description ?? partial.label,
  url: partial.url ?? `https://github.com/org/repo/pull/${partial.itemKey}`,
  tokens: partial.tokens ?? `${partial.itemKey} ${partial.label}`.toLowerCase(),
  updatedAt: partial.updatedAt ?? 1,
  ...partial,
});

const testLayer = Layer.effect(MentionIndex, make).pipe(Layer.provide(KeyValueStore.layerMemory));

const oldScopeBlob = JSON.stringify({
  rows: [
    {
      providerId: "pull-request",
      itemKey: "org/repo#1",
      label: "#1",
      description: "old",
      url: "https://github.com/org/repo/pull/1",
      tokens: "1 #1 old",
      updatedAt: 1,
    },
  ],
  meta: { syncedAt: 10, status: "ready" },
});

it.effect("searches locally without needing a network round trip", () =>
  Effect.gen(function* () {
    const index = yield* MentionIndex;
    const scopeKey = mentionIndexScopeKey("pull-request", projectId);
    yield* index.replaceScope(scopeKey, [
      row({
        itemKey: "org/repo#42",
        label: "#42",
        description: "Improve context chips",
        tokens: "42 #42 improve context chips org/repo",
        pullRequest: {
          number: 42,
          title: "Improve context chips",
          url: "https://github.com/org/repo/pull/42",
          headBranch: "feat/chips",
          baseBranch: "main",
          state: "open",
          isDraft: false,
          projectId,
          repository: "org/repo",
        },
      }),
      row({
        itemKey: "org/repo#7",
        label: "#7",
        description: "Unrelated",
        tokens: "7 #7 unrelated org/repo",
      }),
    ]);

    const result = yield* index.search({
      projectId,
      providers: ["pull-request"],
      query: "context",
      limit: 10,
    });

    expect(result.status).toBe("ready");
    expect(result.hits.map((hit) => hit.label)).toEqual(["#42"]);
    expect(result.hits[0]?.pullRequest?.number).toBe(42);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("ranks an exact number above a substring title hit", () =>
  Effect.gen(function* () {
    const index = yield* MentionIndex;
    const scopeKey = mentionIndexScopeKey("pull-request", projectId);
    yield* index.replaceScope(scopeKey, [
      row({
        itemKey: "org/repo#420",
        label: "#420",
        tokens: "420 #420 something else",
      }),
      row({
        itemKey: "org/repo#42",
        label: "#42",
        tokens: "42 #42 exact",
      }),
    ]);

    const result = yield* index.search({
      projectId,
      providers: ["pull-request"],
      query: "42",
      limit: 10,
    });

    expect(result.hits.map((hit) => hit.label)).toEqual(["#42", "#420"]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("loadScope retains a newer published scope over a concurrent stale disk load", () =>
  Effect.gen(function* () {
    const scopeKey = mentionIndexScopeKey("pull-request", projectId);
    const disk = new Map<string, string>([[`scope:${scopeKey}`, oldScopeBlob]]);
    const readStarted = yield* Deferred.make<void>();
    const allowRead = yield* Deferred.make<void>();
    let gateScopeReads = false;

    const store = KeyValueStore.makeStringOnly({
      get: (key) =>
        Effect.gen(function* () {
          if (gateScopeReads && key === `scope:${scopeKey}`) {
            yield* Deferred.succeed(readStarted, undefined);
            yield* Deferred.await(allowRead);
          }
          return disk.get(key);
        }),
      set: (key, value) =>
        Effect.sync(() => {
          disk.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          disk.delete(key);
        }),
      clear: Effect.sync(() => {
        disk.clear();
      }),
      size: Effect.sync(() => disk.size),
      keys: Effect.sync(() => [...disk.keys()]),
    });

    const index = yield* make.pipe(Effect.provideService(KeyValueStore.KeyValueStore, store));

    gateScopeReads = true;
    const loading = yield* index
      .search({
        projectId,
        providers: ["pull-request"],
        query: "",
        limit: 10,
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(readStarted);

    // Publish newer while the concurrent loadScope is still awaiting disk.
    gateScopeReads = false;
    yield* index.replaceScope(
      scopeKey,
      [
        row({
          itemKey: "org/repo#2",
          label: "#2",
          description: "new",
          tokens: "2 #2 new",
          updatedAt: 2,
        }),
      ],
      { syncedAt: 100, status: "ready" },
    );

    yield* Deferred.succeed(allowRead, undefined);
    const result = yield* Fiber.join(loading);
    expect(result.hits.map((hit) => hit.label)).toEqual(["#2"]);
    expect(result.syncedAt).toBe(100);
  }),
);

it.effect("loadScope prefers a concurrent syncing hot scope over a cold empty disk miss", () =>
  Effect.gen(function* () {
    const scopeKey = mentionIndexScopeKey("pull-request", projectId);
    const disk = new Map<string, string>();
    const readStarted = yield* Deferred.make<void>();
    const allowRead = yield* Deferred.make<void>();
    let gateScopeReads = false;

    const store = KeyValueStore.makeStringOnly({
      get: (key) =>
        Effect.gen(function* () {
          if (gateScopeReads && key === `scope:${scopeKey}`) {
            yield* Deferred.succeed(readStarted, undefined);
            yield* Deferred.await(allowRead);
          }
          return disk.get(key);
        }),
      set: (key, value) =>
        Effect.sync(() => {
          disk.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          disk.delete(key);
        }),
      clear: Effect.sync(() => {
        disk.clear();
      }),
      size: Effect.sync(() => disk.size),
      keys: Effect.sync(() => [...disk.keys()]),
    });

    const index = yield* make.pipe(Effect.provideService(KeyValueStore.KeyValueStore, store));

    gateScopeReads = true;
    const loading = yield* index
      .search({
        projectId,
        providers: ["pull-request"],
        query: "",
        limit: 10,
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(readStarted);

    gateScopeReads = false;
    yield* index.markSyncing(scopeKey);

    yield* Deferred.succeed(allowRead, undefined);
    const result = yield* Fiber.join(loading);
    expect(result.status).toBe("syncing");
  }),
);
