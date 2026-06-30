import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { WorkflowOutboundConnectionStore } from "../Services/WorkflowOutboundConnectionStore.ts";
import { WorkflowOutboundConnectionStoreLayer } from "./WorkflowOutboundConnectionStore.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import type { UrlValidatorDeps } from "../outbound/OutboundUrlValidator.ts";
import { OutboundUrlError } from "../outbound/OutboundUrlValidator.ts";

// ---------------------------------------------------------------------------
// Stub ServerSecretStore backed by an in-memory Map
// ---------------------------------------------------------------------------
const makeInMemorySecretStore = () => {
  const store = new Map<string, Uint8Array>();
  const layer = Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) => Effect.succeed(Option.fromNullishOr(store.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        store.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        store.set(name, value);
      }),
    getOrCreateRandom: (_name, _bytes) => Effect.die("not needed in test"),
    remove: (name) =>
      Effect.sync(() => {
        store.delete(name);
      }),
  } satisfies ServerSecretStore.ServerSecretStore["Service"]);
  return { layer, store };
};

// ---------------------------------------------------------------------------
// Stub validator deps: public IP resolves ok; private IP is SSRF-blocked
// ---------------------------------------------------------------------------
const makePublicLookup = (): UrlValidatorDeps => ({
  lookup: (_host) => Effect.succeed(["140.82.112.3"]),
});

const makePrivateLookup = (): UrlValidatorDeps => ({
  lookup: (_host) => Effect.succeed(["127.0.0.1"]),
});

const makeFailLookup = (): UrlValidatorDeps => ({
  lookup: (_host) =>
    Effect.fail(new OutboundUrlError({ reason: "DNS resolution failed for test (ENOTFOUND)" })),
});

// ---------------------------------------------------------------------------
// Test layer builder
// ---------------------------------------------------------------------------
const buildTestLayer = (validatorDeps: UrlValidatorDeps = makePublicLookup()) => {
  const { layer: secretStoreLayer, store: secretStore } = makeInMemorySecretStore();

  const layer = WorkflowOutboundConnectionStoreLayer(validatorDeps).pipe(
    Layer.provide(DeterministicWorkflowIds),
    Layer.provide(secretStoreLayer),
    Layer.provide(MigrationsLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  return { layer, secretStore };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("WorkflowOutboundConnectionStore", () => {
  it.effect("create → list → getTarget round-trips the secret URL", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowOutboundConnectionStore;

      const view = yield* store.create({
        kind: "slack",
        displayName: "My Slack Webhook",
        url: "https://hooks.slack.com/x",
      });

      expect(view.kind).toBe("slack");
      expect(view.displayName).toBe("My Slack Webhook");
      expect(typeof view.connectionRef).toBe("string");
      expect(view.connectionRef.length).toBeGreaterThan(0);
      // URL must NOT be in the view
      expect((view as Record<string, unknown>)["url"]).toBeUndefined();

      const connections = yield* store.list();
      expect(connections).toHaveLength(1);
      expect(connections[0]!.connectionRef).toBe(view.connectionRef);

      const target = yield* store.getTarget(view.connectionRef);
      expect(target.kind).toBe("slack");
      expect(target.url).toBe("https://hooks.slack.com/x");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("create rejects an SSRF-blocked URL and writes no row", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowOutboundConnectionStore;

      // This URL resolves to 127.0.0.1 (loopback) — SSRF blocked.
      const result = yield* Effect.exit(
        store.create({
          kind: "webhook",
          displayName: "Internal Target",
          url: "https://internal.example.com/hook",
        }),
      );
      expect(result._tag).toBe("Failure");

      // No row should have been inserted
      const connections = yield* store.list();
      expect(connections).toHaveLength(0);
    }).pipe(Effect.provide(buildTestLayer(makePrivateLookup()).layer)),
  );

  it.effect("create rejects when DNS lookup fails entirely", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowOutboundConnectionStore;

      const result = yield* Effect.exit(
        store.create({
          kind: "webhook",
          displayName: "Unknown Host",
          url: "https://totally-nonexistent.example.invalid/hook",
        }),
      );
      expect(result._tag).toBe("Failure");

      const connections = yield* store.list();
      expect(connections).toHaveLength(0);
    }).pipe(Effect.provide(buildTestLayer(makeFailLookup()).layer)),
  );

  it.effect("getTarget fails for an unknown connectionRef", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowOutboundConnectionStore;
      const result = yield* Effect.exit(store.getTarget("conn-nonexistent-ref"));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("remove deletes the row (dangling refs allowed; no board scan)", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowOutboundConnectionStore;

      const view = yield* store.create({
        kind: "webhook",
        displayName: "To Remove",
        url: "https://hooks.example.com/webhook",
      });

      const before = yield* store.list();
      expect(before.some((c) => c.connectionRef === view.connectionRef)).toBe(true);

      yield* store.remove(view.connectionRef);

      const after = yield* store.list();
      expect(after.some((c) => c.connectionRef === view.connectionRef)).toBe(false);

      // getTarget also fails after removal
      const targetResult = yield* Effect.exit(store.getTarget(view.connectionRef));
      expect(targetResult._tag).toBe("Failure");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("list returns all views without the URL field", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowOutboundConnectionStore;

      yield* store.create({
        kind: "webhook",
        displayName: "First",
        url: "https://a.example.com/hook",
      });
      yield* store.create({
        kind: "slack",
        displayName: "Second",
        url: "https://b.example.com/hook",
      });

      const connections = yield* store.list();
      expect(connections).toHaveLength(2);
      expect(connections.map((c) => c.displayName).sort()).toEqual(["First", "Second"]);
      // URL must NOT be present in any view
      for (const conn of connections) {
        expect((conn as Record<string, unknown>)["url"]).toBeUndefined();
      }
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect(
    "getTarget fails gracefully when secret is missing (row exists, secret deleted)",
    () => {
      const { layer, secretStore } = buildTestLayer();
      return Effect.gen(function* () {
        const store = yield* WorkflowOutboundConnectionStore;

        const view = yield* store.create({
          kind: "webhook",
          displayName: "Orphaned Row",
          url: "https://hooks.example.com/orphan",
        });

        // Simulate out-of-band secret removal: delete from the backing map while
        // the row remains in SQLite (mirrors the WorkSourceConnectionStore test).
        secretStore.delete(`outbound-target:${view.connectionRef}`);

        const result = yield* Effect.exit(store.getTarget(view.connectionRef));
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("create writes no listable row when the secret store fails", () => {
    // Secret-before-row ordering: if the secret write fails, create aborts
    // before inserting the row, so no half-created connection (row present but
    // secret missing → getTarget fails) is ever listable.
    const failingSecretStoreLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.fail(new ServerSecretStore.SecretStorePersistError({ resource: "backend down", cause: new Error("backend down") })),
      create: () => Effect.fail(new ServerSecretStore.SecretStorePersistError({ resource: "unused", cause: new Error("unused") })),
      getOrCreateRandom: () => Effect.die("not needed in test"),
      remove: () => Effect.void,
    } satisfies ServerSecretStore.ServerSecretStore["Service"]);
    const layer = WorkflowOutboundConnectionStoreLayer(makePublicLookup()).pipe(
      Layer.provide(DeterministicWorkflowIds),
      Layer.provide(failingSecretStoreLayer),
      Layer.provide(MigrationsLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    return Effect.gen(function* () {
      const store = yield* WorkflowOutboundConnectionStore;
      const result = yield* Effect.exit(
        store.create({
          kind: "webhook",
          displayName: "Secret Write Fails",
          url: "https://hooks.example.com/x",
        }),
      );
      expect(result._tag).toBe("Failure");
      const connections = yield* store.list();
      expect(connections).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("remove of a nonexistent connectionRef succeeds (idempotent)", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowOutboundConnectionStore;
      // Should not throw — no row to delete is fine
      yield* store.remove("conn-does-not-exist");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );
});

// Suppress unused import warning for FileSystem / Path (used indirectly via SqlitePersistenceMemory)
void FileSystem;
void Path;
