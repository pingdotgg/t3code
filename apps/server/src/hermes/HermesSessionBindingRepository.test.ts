// @effect-diagnostics nodeBuiltinImport:off - Restart coverage needs a real file-backed SQLite database.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  HermesSessionBindingRepository,
  layer as HermesSessionBindingRepositoryLayer,
} from "./HermesSessionBindingRepository.ts";

const T0 = "2026-07-24T12:00:00.000Z";
const T1 = "2026-07-24T12:00:10.000Z";
const T2 = "2026-07-24T12:00:20.000Z";
const T3 = "2026-07-24T12:00:30.000Z";
const T4 = "2026-07-24T12:00:40.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function testLayer(databaseLayer: Layer.Layer<SqlClient.SqlClient, SqlError>) {
  return HermesSessionBindingRepositoryLayer.pipe(Layer.provideMerge(databaseLayer));
}

const memory = it.layer(testLayer(NodeSqliteClient.layerMemory()));

function createBinding(
  repository: HermesSessionBindingRepository["Service"],
  overrides: Partial<Parameters<typeof repository.createBinding>[0]> = {},
) {
  return repository.createBinding({
    bindingId: "hermes-binding:1",
    providerInstanceId: "hermes-local",
    profileKey: "profile:default",
    projectId: "project:1",
    storedSessionKey: "stored:conversation-1",
    threadId: "thread:1",
    protocolClassification: "supported",
    protocolMajor: 1,
    protocolMinor: 4,
    capabilities: ["turn.prompt", "session.lifecycle", "turn.prompt"],
    reconciliationCursor: "cursor:7",
    reconciliationFingerprint: "fingerprint:7",
    now: T0,
    ...overrides,
  });
}

memory("HermesSessionBindingRepository", (it) => {
  it.effect("keeps session imports idempotent and enforces one Main per profile", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 46 });
      const repository = yield* HermesSessionBindingRepository;

      const first = yield* repository.prepareSessionImport({
        importId: "import:session:1",
        providerInstanceId: "hermes-local",
        profileKey: "profile:default",
        projectId: "project:1",
        importKind: "session",
        storedSessionKey: "stored:1",
        threadId: "thread:import:1",
        now: T0,
      });
      const replay = yield* repository.prepareSessionImport({
        importId: "import:session:replay",
        providerInstanceId: "hermes-local",
        profileKey: "profile:default",
        projectId: "project:1",
        importKind: "session",
        storedSessionKey: "stored:1",
        threadId: "thread:import:other",
        now: T1,
      });
      assert.strictEqual(replay.importId, first.importId);
      assert.strictEqual(replay.threadId, first.threadId);

      assert.isTrue(
        yield* repository.transitionSessionImport({
          importId: first.importId,
          from: "prepared",
          to: "thread_created",
          now: T1,
        }),
      );
      assert.isTrue(
        yield* repository.transitionSessionImport({
          importId: first.importId,
          from: "thread_created",
          to: "completed",
          now: T2,
        }),
      );
      const imported = yield* repository.getSessionImportByStoredIdentity({
        providerInstanceId: "hermes-local",
        profileKey: "profile:default",
        projectId: "project:1",
        storedSessionKey: "stored:1",
      });
      assert.isTrue(Option.isSome(imported));
      if (Option.isSome(imported)) assert.strictEqual(imported.value.state, "completed");

      const main = yield* repository.prepareSessionImport({
        importId: "import:main:1",
        providerInstanceId: "hermes-local",
        profileKey: "profile:default",
        projectId: "project:1",
        importKind: "main",
        storedSessionKey: null,
        threadId: "thread:main:1",
        now: T0,
      });
      const competingMain = yield* repository.prepareSessionImport({
        importId: "import:main:2",
        providerInstanceId: "hermes-local",
        profileKey: "profile:default",
        projectId: "project:1",
        importKind: "main",
        storedSessionKey: null,
        threadId: "thread:main:2",
        now: T1,
      });
      assert.strictEqual(competingMain.importId, main.importId);
      assert.strictEqual(competingMain.threadId, "thread:main:1");
    }),
  );

  it.effect("clears every local Hermes binding and import so sessions can be imported again", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 46 });
      const repository = yield* HermesSessionBindingRepository;

      yield* repository.prepareSessionImport({
        importId: "import:session:reset",
        providerInstanceId: "hermes-local",
        profileKey: "profile:reset",
        projectId: "project:1",
        importKind: "session",
        storedSessionKey: "stored:reset",
        threadId: "thread:reset",
        now: T0,
      });
      yield* repository.prepareSessionImport({
        importId: "import:other-profile",
        providerInstanceId: "hermes-local",
        profileKey: "profile:other",
        projectId: "project:1",
        importKind: "session",
        storedSessionKey: "stored:other-profile",
        threadId: "thread:other-profile",
        now: T0,
      });
      yield* repository.prepareSessionImport({
        importId: "import:other-provider",
        providerInstanceId: "hermes-other",
        profileKey: "profile:default",
        projectId: "project:1",
        importKind: "session",
        storedSessionKey: "stored:other-provider",
        threadId: "thread:other-provider",
        now: T0,
      });
      yield* createBinding(repository, {
        bindingId: "binding:reset",
        profileKey: "profile:reset",
        storedSessionKey: "stored:reset",
        threadId: "thread:reset",
      });
      yield* createBinding(repository, {
        bindingId: "binding:other-project",
        profileKey: "profile:reset",
        projectId: "project:other",
        storedSessionKey: "stored:other",
        threadId: "thread:other",
      });

      const scope = {
        providerInstanceId: "hermes-local",
        profileKey: "profile:reset",
        projectId: "project:1",
      };
      assert.deepEqual(yield* repository.listHistoryThreadIds(scope), ["thread:reset"]);
      assert.strictEqual(yield* repository.clearHistoryRecords(scope), 1);
      assert.isTrue(
        Option.isNone(
          yield* repository.getSessionImportByStoredIdentity({
            providerInstanceId: "hermes-local",
            profileKey: "profile:reset",
            projectId: "project:1",
            storedSessionKey: "stored:reset",
          }),
        ),
      );
      assert.isTrue(Option.isNone(yield* repository.getByThreadId("thread:reset")));
      assert.isTrue(Option.isSome(yield* repository.getByThreadId("thread:other")));
      assert.isTrue(
        Option.isSome(
          yield* repository.getSessionImportByStoredIdentity({
            providerInstanceId: "hermes-local",
            profileKey: "profile:other",
            projectId: "project:1",
            storedSessionKey: "stored:other-profile",
          }),
        ),
      );
      assert.isTrue(
        Option.isSome(
          yield* repository.getSessionImportByStoredIdentity({
            providerInstanceId: "hermes-other",
            profileKey: "profile:default",
            projectId: "project:1",
            storedSessionKey: "stored:other-provider",
          }),
        ),
      );
      assert.deepEqual(yield* repository.listHistoryThreadIds(scope), []);
    }),
  );

  it.effect("rejects a scoped reset while a mutation is unsettled and preserves its records", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 46 });
      const repository = yield* HermesSessionBindingRepository;
      yield* createBinding(repository);
      const lease = yield* repository.acquireOwnerLease({
        bindingId: "hermes-binding:1",
        ownerKey: "reset-test-owner",
        expectedGeneration: 0,
        now: T0,
        expiresAt: T4,
      });
      assert.isTrue(Option.isSome(lease));
      const prepared = yield* repository.prepareMutationIntent({
        bindingId: "hermes-binding:1",
        ownerKey: "reset-test-owner",
        generation: 1,
        now: T1,
        operationId: "operation:unsettled-reset",
        mutationKind: "prompt",
        method: "prompt.submit",
        payloadDigest: DIGEST_A,
      });
      assert.strictEqual(prepared.status, "prepared");

      const error = yield* Effect.flip(
        repository.clearHistoryRecords({
          providerInstanceId: "hermes-local",
          profileKey: "profile:default",
          projectId: "project:1",
        }),
      );
      assert.include(error.detail, "unsettled Hermes mutation");
      assert.isTrue(Option.isSome(yield* repository.getByThreadId("thread:1")));
      assert.isTrue(
        Option.isSome(yield* repository.getMutationIntent("operation:unsettled-reset")),
      );
      assert.isTrue(
        yield* repository.transitionMutationIntent({
          bindingId: "hermes-binding:1",
          ownerKey: "reset-test-owner",
          generation: 1,
          now: T2,
          operationId: "operation:unsettled-reset",
          from: "prepared",
          to: "rejected",
        }),
      );
      yield* repository.clearHistoryRecords({
        providerInstanceId: "hermes-local",
        profileKey: "profile:default",
        projectId: "project:1",
      });
    }),
  );

  it.effect(
    "enforces both durable identity uniqueness domains and stores negotiation metadata",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 46 });
        const repository = yield* HermesSessionBindingRepository;

        assert.isTrue(yield* createBinding(repository));
        assert.isFalse(
          yield* createBinding(repository, {
            bindingId: "hermes-binding:duplicate-identity",
            threadId: "thread:2",
          }),
        );
        assert.isFalse(
          yield* createBinding(repository, {
            bindingId: "hermes-binding:duplicate-thread",
            storedSessionKey: "stored:conversation-2",
          }),
        );

        const byThread = yield* repository.getByThreadId("thread:1");
        assert.isTrue(Option.isSome(byThread));
        if (Option.isNone(byThread)) return;
        assert.deepStrictEqual(byThread.value.capabilities, ["session.lifecycle", "turn.prompt"]);
        assert.strictEqual(byThread.value.protocolClassification, "supported");
        assert.strictEqual(byThread.value.projectId, "project:1");
        assert.strictEqual(byThread.value.protocolMajor, 1);
        assert.strictEqual(byThread.value.protocolMinor, 4);
        assert.strictEqual(byThread.value.reconciliationCursor, "cursor:7");
        assert.strictEqual(byThread.value.reconciliationFingerprint, "fingerprint:7");
        assert.strictEqual(byThread.value.leaseGeneration, 0);

        const byIdentity = yield* repository.getByStoredIdentity({
          providerInstanceId: "hermes-local",
          profileKey: "profile:default",
          storedSessionKey: "stored:conversation-1",
        });
        assert.isTrue(Option.isSome(byIdentity));
        if (Option.isSome(byIdentity)) {
          assert.strictEqual(byIdentity.value.bindingId, "hermes-binding:1");
        }
      }),
  );

  it.effect("uses generation and expiry CAS to fence lease-owned metadata writes", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 46 });
      const repository = yield* HermesSessionBindingRepository;
      yield* createBinding(repository);

      const first = yield* repository.acquireOwnerLease({
        bindingId: "hermes-binding:1",
        ownerKey: "owner:a",
        expectedGeneration: 0,
        now: T0,
        expiresAt: T2,
      });
      assert.isTrue(Option.isSome(first));
      if (Option.isNone(first)) return;
      assert.strictEqual(first.value.generation, 1);

      assert.isTrue(
        yield* repository.updateNegotiation({
          bindingId: "hermes-binding:1",
          ownerKey: "owner:a",
          generation: 1,
          now: T1,
          protocolClassification: "legacy",
          protocolMajor: null,
          protocolMinor: null,
          capabilities: ["session.lifecycle"],
        }),
      );
      assert.isTrue(
        yield* repository.updateReconciliation({
          bindingId: "hermes-binding:1",
          ownerKey: "owner:a",
          generation: 1,
          now: T1,
          cursor: "cursor:8",
          fingerprint: "fingerprint:8",
        }),
      );

      const busy = yield* repository.acquireOwnerLease({
        bindingId: "hermes-binding:1",
        ownerKey: "owner:b",
        expectedGeneration: 1,
        now: T1,
        expiresAt: T3,
      });
      assert.isTrue(Option.isNone(busy));

      const takeover = yield* repository.acquireOwnerLease({
        bindingId: "hermes-binding:1",
        ownerKey: "owner:b",
        expectedGeneration: 1,
        now: T2,
        expiresAt: T4,
      });
      assert.isTrue(Option.isSome(takeover));
      if (Option.isNone(takeover)) return;
      assert.strictEqual(takeover.value.generation, 2);

      assert.isFalse(
        yield* repository.renewOwnerLease({
          bindingId: "hermes-binding:1",
          ownerKey: "owner:a",
          generation: 1,
          now: T2,
          expiresAt: T4,
        }),
      );
      assert.isFalse(
        yield* repository.updateReconciliation({
          bindingId: "hermes-binding:1",
          ownerKey: "owner:a",
          generation: 1,
          now: T2,
          cursor: "stale-cursor",
          fingerprint: "stale-fingerprint",
        }),
      );
    }),
  );
});

it.effect("records the inherited history boundary once and preserves it afterwards", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 49 });
    const repository = yield* HermesSessionBindingRepository;

    const prepared = yield* repository.prepareSessionImport({
      importId: "import:session:boundary",
      providerInstanceId: "hermes-local",
      profileKey: "profile:default",
      projectId: "project:1",
      importKind: "session",
      storedSessionKey: "stored:boundary",
      threadId: "thread:boundary",
      now: T0,
    });
    assert.strictEqual(prepared.inheritedMessageCount, null);

    const recorded = yield* repository.setSessionImportInheritedCount({
      importId: prepared.importId,
      inheritedMessageCount: 7,
      now: T1,
    });
    assert.strictEqual(recorded, 7);

    // A later hydration seeing a longer history must not move the boundary.
    const preserved = yield* repository.setSessionImportInheritedCount({
      importId: prepared.importId,
      inheritedMessageCount: 12,
      now: T2,
    });
    assert.strictEqual(preserved, 7);

    const reread = yield* repository.getSessionImportByStoredIdentity({
      providerInstanceId: "hermes-local",
      profileKey: "profile:default",
      projectId: "project:1",
      storedSessionKey: "stored:boundary",
    });
    assert.isTrue(Option.isSome(reread));
    if (Option.isSome(reread)) assert.strictEqual(reread.value.inheritedMessageCount, 7);
  }).pipe(Effect.provide(testLayer(NodeSqliteClient.layerMemory())), Effect.scoped),
);

it.effect("persists ambiguous mutation recovery across a file-backed SQLite restart", () => {
  const directory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-hermes-session-binding-"),
  );
  const databasePath = NodePath.join(directory, "state.sqlite");
  const privatePrompt = "PRIVATE PROMPT THAT MUST NEVER REACH SQLITE";

  const firstRuntime = Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 46 });
    const repository = yield* HermesSessionBindingRepository;
    yield* createBinding(repository);
    const lease = yield* repository.acquireOwnerLease({
      bindingId: "hermes-binding:1",
      ownerKey: "owner:first-runtime",
      expectedGeneration: 0,
      now: T0,
      expiresAt: T2,
    });
    assert.isTrue(Option.isSome(lease));

    const prepared = yield* repository.prepareMutationIntent({
      bindingId: "hermes-binding:1",
      ownerKey: "owner:first-runtime",
      generation: 1,
      now: T0,
      operationId: "operation:prompt-1",
      mutationKind: "prompt",
      method: "prompt.submit",
      payloadDigest: DIGEST_A,
    });
    assert.strictEqual(prepared.status, "prepared");

    const concurrent = yield* repository.prepareMutationIntent({
      bindingId: "hermes-binding:1",
      ownerKey: "owner:first-runtime",
      generation: 1,
      now: T1,
      operationId: "operation:prompt-2",
      mutationKind: "prompt",
      method: "prompt.submit",
      payloadDigest: DIGEST_B,
    });
    assert.deepStrictEqual(concurrent, {
      status: "unsettled_prompt",
      operationId: "operation:prompt-1",
    });

    assert.isTrue(
      yield* repository.transitionMutationIntent({
        bindingId: "hermes-binding:1",
        ownerKey: "owner:first-runtime",
        generation: 1,
        now: T1,
        operationId: "operation:prompt-1",
        from: "prepared",
        to: "admitted",
      }),
    );
    assert.isTrue(
      yield* repository.transitionMutationIntent({
        bindingId: "hermes-binding:1",
        ownerKey: "owner:first-runtime",
        generation: 1,
        now: T1,
        operationId: "operation:prompt-1",
        from: "admitted",
        to: "indeterminate",
      }),
    );
  }).pipe(
    Effect.provide(testLayer(NodeSqliteClient.layer({ filename: databasePath }))),
    Effect.scoped,
  );

  const secondRuntime = Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 46 });
    const repository = yield* HermesSessionBindingRepository;
    const unsettled = yield* repository.listUnsettledMutationIntents("hermes-binding:1");
    assert.deepStrictEqual(
      unsettled.map(({ operationId, state, payloadDigest }) => ({
        operationId,
        state,
        payloadDigest,
      })),
      [
        {
          operationId: "operation:prompt-1",
          state: "indeterminate",
          payloadDigest: DIGEST_A,
        },
      ],
    );

    const takeover = yield* repository.acquireOwnerLease({
      bindingId: "hermes-binding:1",
      ownerKey: "owner:second-runtime",
      expectedGeneration: 1,
      now: T2,
      expiresAt: T4,
    });
    assert.isTrue(Option.isSome(takeover));
    if (Option.isNone(takeover)) return;
    assert.strictEqual(takeover.value.generation, 2);

    const stillBlocked = yield* repository.prepareMutationIntent({
      bindingId: "hermes-binding:1",
      ownerKey: "owner:second-runtime",
      generation: 2,
      now: T2,
      operationId: "operation:prompt-2",
      mutationKind: "prompt",
      method: "prompt.submit",
      payloadDigest: DIGEST_B,
    });
    assert.strictEqual(stillBlocked.status, "unsettled_prompt");

    assert.isTrue(
      yield* repository.transitionMutationIntent({
        bindingId: "hermes-binding:1",
        ownerKey: "owner:second-runtime",
        generation: 2,
        now: T2,
        operationId: "operation:prompt-1",
        from: "indeterminate",
        to: "reconciled",
      }),
    );
    const afterReconciliation = yield* repository.prepareMutationIntent({
      bindingId: "hermes-binding:1",
      ownerKey: "owner:second-runtime",
      generation: 2,
      now: T3,
      operationId: "operation:prompt-2",
      mutationKind: "prompt",
      method: "prompt.submit",
      payloadDigest: DIGEST_B,
    });
    assert.strictEqual(afterReconciliation.status, "prepared");

    const sql = yield* SqlClient.SqlClient;
    const stored = yield* sql<{
      readonly payload_digest: string;
      readonly state: string;
    }>`
      SELECT payload_digest, state
      FROM hermes_mutation_intents
      WHERE operation_id = 'operation:prompt-2'
    `;
    assert.deepStrictEqual(stored, [{ payload_digest: DIGEST_B, state: "prepared" }]);
  }).pipe(
    Effect.provide(testLayer(NodeSqliteClient.layer({ filename: databasePath }))),
    Effect.scoped,
  );

  return Effect.gen(function* () {
    yield* firstRuntime;
    yield* secondRuntime;
    const databaseBytes = NodeFS.readFileSync(databasePath);
    assert.notInclude(databaseBytes.toString("utf8"), privatePrompt);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }),
    ),
  );
});

it.effect(
  "recovers a prepared pre-binding create and atomically attaches it to the binding",
  () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-hermes-prebinding-create-"),
    );
    const databasePath = NodePath.join(directory, "state.sqlite");

    const firstRuntime = Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 46 });
      const repository = yield* HermesSessionBindingRepository;
      const prepared = yield* repository.prepareSessionCreateIntent({
        operationId: "operation:create-1",
        providerInstanceId: "hermes-local",
        profileKey: "profile:default",
        projectId: "project:1",
        threadId: "thread:1",
        runId: "run:1",
        attemptId: "attempt:1",
        messageId: "message:1",
        method: "session.create",
        payloadDigest: DIGEST_A,
        now: T0,
      });
      assert.strictEqual(prepared.status, "prepared");

      const bindings = yield* repository.getByThreadId("thread:1");
      assert.isTrue(Option.isNone(bindings));
    }).pipe(
      Effect.provide(testLayer(NodeSqliteClient.layer({ filename: databasePath }))),
      Effect.scoped,
    );

    const secondRuntime = Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 46 });
      const repository = yield* HermesSessionBindingRepository;
      const recovered = yield* repository.getMutationIntent("operation:create-1");
      assert.isTrue(Option.isSome(recovered));
      if (Option.isNone(recovered)) return;
      assert.deepStrictEqual(
        {
          bindingId: recovered.value.bindingId,
          providerInstanceId: recovered.value.providerInstanceId,
          profileKey: recovered.value.profileKey,
          projectId: recovered.value.projectId,
          threadId: recovered.value.threadId,
          runId: recovered.value.runId,
          attemptId: recovered.value.attemptId,
          messageId: recovered.value.messageId,
          payloadDigest: recovered.value.payloadDigest,
          state: recovered.value.state,
        },
        {
          bindingId: null,
          providerInstanceId: "hermes-local",
          profileKey: "profile:default",
          projectId: "project:1",
          threadId: "thread:1",
          runId: "run:1",
          attemptId: "attempt:1",
          messageId: "message:1",
          payloadDigest: DIGEST_A,
          state: "prepared",
        },
      );

      const concurrent = yield* repository.prepareSessionCreateIntent({
        operationId: "operation:create-2",
        providerInstanceId: "hermes-local",
        profileKey: "profile:default",
        projectId: "project:1",
        threadId: "thread:1",
        method: "session.create",
        payloadDigest: DIGEST_B,
        now: T1,
      });
      assert.deepStrictEqual(concurrent, {
        status: "unsettled_create",
        operationId: "operation:create-1",
      });

      assert.isTrue(
        yield* repository.transitionSessionCreateIntent({
          operationId: "operation:create-1",
          from: "prepared",
          to: "admitted",
          now: T1,
        }),
      );

      const mismatchedAttach = yield* Effect.result(
        createBinding(repository, {
          projectId: "project:mismatch",
          createOperationId: "operation:create-1",
          now: T2,
        }),
      );
      assert.strictEqual(mismatchedAttach._tag, "Failure");
      assert.isTrue(Option.isNone(yield* repository.getByThreadId("thread:1")));

      assert.isTrue(
        yield* createBinding(repository, {
          createOperationId: "operation:create-1",
          now: T2,
        }),
      );
      const binding = yield* repository.getByThreadId("thread:1");
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        assert.strictEqual(binding.value.projectId, "project:1");
        assert.strictEqual(binding.value.storedSessionKey, "stored:conversation-1");
      }

      const confirmed = yield* repository.getMutationIntent("operation:create-1");
      assert.isTrue(Option.isSome(confirmed));
      if (Option.isSome(confirmed)) {
        assert.strictEqual(confirmed.value.bindingId, "hermes-binding:1");
        assert.strictEqual(confirmed.value.state, "confirmed");
        assert.strictEqual(confirmed.value.settledAt, T2);
      }

      assert.isTrue(
        yield* createBinding(repository, {
          createOperationId: "operation:create-1",
          now: T3,
        }),
      );
    }).pipe(
      Effect.provide(testLayer(NodeSqliteClient.layer({ filename: databasePath }))),
      Effect.scoped,
    );

    return Effect.gen(function* () {
      yield* firstRuntime;
      yield* secondRuntime;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
      ),
    );
  },
);
