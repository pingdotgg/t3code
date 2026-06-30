import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { WorkSourceConnectionStore } from "../Services/WorkSourceConnectionStore.ts";
import { WorkSourceConnectionStoreLive } from "./WorkSourceConnectionStore.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";

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
// Test layer
// ---------------------------------------------------------------------------
const buildTestLayer = () => {
  const { layer: secretStoreLayer, store: secretStore } = makeInMemorySecretStore();

  const layer = WorkSourceConnectionStoreLive.pipe(
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
describe("WorkSourceConnectionStore", () => {
  it.effect("create inserts a row and stores the token in the secret store", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;

      const view = yield* store.create({
        provider: "github",
        displayName: "My GitHub",
        token: "ghp_test1234",
      });

      expect(view.provider).toBe("github");
      expect(view.displayName).toBe("My GitHub");
      expect(typeof view.connectionRef).toBe("string");
      expect(view.connectionRef.length).toBeGreaterThan(0);

      // Token must be retrievable
      const token = yield* store.getToken(view.connectionRef, "github");
      expect(token).toBe("ghp_test1234");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect(
    "getToken fails with WorkSourceAuthError when expectedProvider does not match the row",
    () =>
      Effect.gen(function* () {
        const store = yield* WorkSourceConnectionStore;
        const view = yield* store.create({
          provider: "github",
          displayName: "GH conn",
          token: "ghp_bound",
        });

        // Wrong provider for this connectionRef → must NOT return the github token.
        const error = yield* store.getToken(view.connectionRef, "asana").pipe(Effect.flip);
        expect((error as { _tag: string })._tag).toBe("WorkSourceAuthError");

        // Correct provider → token returned.
        const token = yield* store.getToken(view.connectionRef, "github");
        expect(token).toBe("ghp_bound");
      }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("list returns all views without the token", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;

      yield* store.create({ provider: "github", displayName: "GH 1", token: "tok-1" });
      yield* store.create({ provider: "asana", displayName: "Asana 1", token: "tok-2" });

      const connections = yield* store.list();
      expect(connections).toHaveLength(2);
      expect(connections.map((c) => c.provider).sort()).toEqual(["asana", "github"]);
      // No token field in view
      for (const conn of connections) {
        expect((conn as Record<string, unknown>)["token"]).toBeUndefined();
      }
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("getToken returns the stored PAT as a string", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const view = yield* store.create({
        provider: "asana",
        displayName: "Asana connection",
        token: "asana-pat-abc",
      });

      const token = yield* store.getToken(view.connectionRef, "asana");
      expect(token).toBe("asana-pat-abc");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("getToken fails with WorkSourceAuthError for unknown connectionRef", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const result = yield* Effect.exit(store.getToken("nonexistent-ref", "github"));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("getToken fails gracefully when the row exists but its secret is missing", () => {
    // INSERT-before-secret create ordering can leave a row whose secret was
    // never stored (or was removed out of band). getToken must degrade to a
    // typed WorkSourceAuthError rather than crashing.
    const { layer, secretStore } = buildTestLayer();
    return Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const view = yield* store.create({
        provider: "github",
        displayName: "Orphaned secret",
        token: "soon-to-vanish",
      });

      // Simulate the row-exists-but-secret-missing state by deleting the secret
      // directly from the backing map (the row remains in SQLite).
      secretStore.delete(`work-source-token:${view.connectionRef}`);

      // getToken fails in the typed error channel (not a defect) with WorkSourceAuthError.
      const error = yield* store.getToken(view.connectionRef, "github").pipe(Effect.flip);
      expect((error as { _tag: string })._tag).toBe("WorkSourceAuthError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("remove deletes the row and the secret", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;

      const view = yield* store.create({
        provider: "github",
        displayName: "To be deleted",
        token: "delete-me-token",
      });

      // Exists before remove
      const before = yield* store.list();
      expect(before.some((c) => c.connectionRef === view.connectionRef)).toBe(true);

      yield* store.remove(view.connectionRef);

      // Gone after remove
      const after = yield* store.list();
      expect(after.some((c) => c.connectionRef === view.connectionRef)).toBe(false);

      // Token is also gone
      const tokenResult = yield* Effect.exit(store.getToken(view.connectionRef, "github"));
      expect(tokenResult._tag).toBe("Failure");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("persists authMode + baseUrl and exposes them via list + getConnectionAuth", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;

      const view = yield* store.create({
        provider: "github",
        displayName: "GH with base url",
        token: "ghp_x",
        authMode: "bearer",
        baseUrl: "https://example.test",
        email: "me@example.test",
      });

      // View carries the non-secret fields
      expect(view.authMode).toBe("bearer");
      expect(view.baseUrl).toBe("https://example.test");

      // getConnectionAuth returns the full bundle (token + non-secret fields)
      const auth = yield* store.getConnectionAuth(view.connectionRef, "github");
      expect(auth.token).toBe("ghp_x");
      expect(auth.authMode).toBe("bearer");
      expect(auth.baseUrl).toBe("https://example.test");
      expect(auth.email).toBe("me@example.test");

      // list()/toView path surfaces the same non-secret fields
      const views = yield* store.list();
      const persisted = views.find((v) => v.connectionRef === view.connectionRef);
      expect(persisted?.authMode).toBe("bearer");
      expect(persisted?.baseUrl).toBe("https://example.test");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("defaults authMode to 'pat' and base_url/email to null when omitted", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const view = yield* store.create({
        provider: "asana",
        displayName: "Plain asana",
        token: "tok",
      });
      expect(view.authMode).toBe("pat");
      expect(view.baseUrl).toBeNull();

      const auth = yield* store.getConnectionAuth(view.connectionRef, "asana");
      expect(auth.authMode).toBe("pat");
      expect(auth.baseUrl).toBeNull();
      expect(auth.email).toBeNull();
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("getConnectionAuth is provider-bound (wrong provider → WorkSourceAuthError)", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const view = yield* store.create({
        provider: "github",
        displayName: "Bound",
        token: "ghp_bound",
      });
      const error = yield* store.getConnectionAuth(view.connectionRef, "asana").pipe(Effect.flip);
      expect((error as { _tag: string })._tag).toBe("WorkSourceAuthError");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("getConnectionAuth fails gracefully when the row exists but its secret is missing", () => {
    // Mirrors the getToken orphaned-secret case: a row whose secret was never
    // stored (or removed out of band) must degrade to a typed
    // WorkSourceAuthError rather than crashing.
    const { layer, secretStore } = buildTestLayer();
    return Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const view = yield* store.create({
        provider: "github",
        displayName: "Orphaned secret (auth)",
        token: "soon-to-vanish",
      });

      // Simulate the row-exists-but-secret-missing state.
      secretStore.delete(`work-source-token:${view.connectionRef}`);

      const error = yield* store.getConnectionAuth(view.connectionRef, "github").pipe(Effect.flip);
      expect((error as { _tag: string })._tag).toBe("WorkSourceAuthError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("create rejects a Jira connection without a base URL", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const error = yield* store
        .create({ provider: "jira", displayName: "Jira", token: "t", authMode: "bearer" })
        .pipe(Effect.flip);
      expect((error as { _tag: string })._tag).toBe("WorkSourceConnectionStoreError");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("create rejects a Jira Cloud (basic) connection without an email", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const error = yield* store
        .create({
          provider: "jira",
          displayName: "Jira Cloud",
          token: "t",
          authMode: "basic",
          baseUrl: "https://acme.atlassian.net",
        })
        .pipe(Effect.flip);
      expect((error as { _tag: string })._tag).toBe("WorkSourceConnectionStoreError");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("create accepts a valid Jira Cloud connection", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const view = yield* store.create({
        provider: "jira",
        displayName: "Jira Cloud",
        token: "t",
        authMode: "basic",
        baseUrl: "https://acme.atlassian.net",
        email: "me@acme.test",
      });
      expect(view.provider).toBe("jira");
      expect(view.authMode).toBe("basic");
      const auth = yield* store.getConnectionAuth(view.connectionRef, "jira");
      expect(auth.email).toBe("me@acme.test");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );

  it.effect("create rejects a Jira connection whose base URL host is blocked (SSRF)", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceConnectionStore;
      const error = yield* store
        .create({
          provider: "jira",
          displayName: "Jira internal",
          token: "t",
          authMode: "bearer",
          baseUrl: "http://169.254.169.254/",
        })
        .pipe(Effect.flip);
      expect((error as { _tag: string })._tag).toBe("WorkSourceConnectionStoreError");
    }).pipe(Effect.provide(buildTestLayer().layer)),
  );
});

// Suppress unused import warning for FileSystem / Path (used indirectly via SqlitePersistenceMemory)
void FileSystem;
void Path;
