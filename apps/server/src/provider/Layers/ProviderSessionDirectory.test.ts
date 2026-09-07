// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionImportSource,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const importedSource = {
  provider: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "provider-session",
  filePath: "/tmp/provider-session.jsonl",
  size: 100,
  mtimeMs: 1_000,
  device: 1,
  inode: 123,
  birthtimeMs: 500,
} satisfies AgentSessionImportSource;

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(Layer.provide(persistenceLayer));
  return Layer.mergeAll(
    persistenceLayer,
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
    NodeServices.layer,
  );
}

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))("ProviderSessionDirectoryLive", (it) => {
  it.effect("upserts and reads thread bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initialThreadId = ThreadId.make("thread-1");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId: initialThreadId,
      });

      const provider = yield* directory.getProvider(initialThreadId);
      assert.equal(provider, "codex");
      const resolvedBinding = yield* directory.getBinding(initialThreadId);
      expect(Option.getOrThrow(resolvedBinding)).toMatchObject({
        threadId: initialThreadId,
        provider: ProviderDriverKind.make("codex"),
      });
      if (Option.isSome(resolvedBinding)) {
        assert.equal(resolvedBinding.value.threadId, initialThreadId);
      }

      const nextThreadId = ThreadId.make("thread-2");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId: nextThreadId,
      });
      const updatedBinding = yield* directory.getBinding(nextThreadId);
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.threadId, nextThreadId);
      }

      const runtime = yield* runtimeRepository.getByThreadId({ threadId: nextThreadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, nextThreadId);
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.providerName, "codex");
      }

      const threadIds = yield* directory.listThreadIds();
      expect(threadIds).toEqual(expect.arrayContaining([initialThreadId, nextThreadId]));
    }),
  );

  it.effect("persists runtime fields and merges payload updates", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = ThreadId.make("thread-runtime");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        status: "starting",
        resumeCursor: {
          threadId: "provider-thread-runtime",
        },
        runtimePayload: {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
        },
      });

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        status: "running",
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, threadId);
        assert.equal(runtime.value.status, "running");
        assert.deepEqual(runtime.value.resumeCursor, {
          threadId: "provider-thread-runtime",
        });
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
          activeTurnId: "turn-1",
        });
      }
    }),
  );

  it.effect("keeps the existing binding when an insert conflicts", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("thread-insert-conflict");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        status: "running",
        resumeCursor: { threadId: "active-provider-thread" },
      });

      yield* directory.upsert(
        {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
          status: "stopped",
          resumeCursor: { threadId: "stale-provider-thread" },
        },
        { onConflict: "ignore" },
      );

      const binding = yield* directory.getBinding(threadId);
      expect(Option.getOrThrow(binding)).toMatchObject({
        threadId,
        status: "running",
        resumeCursor: { threadId: "active-provider-thread" },
      });
    }),
  );

  it.effect("records source files without replacing the current provider session", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = { ...importedSource, providerSessionId: "record-source" };
      const threadId = ThreadId.make(
        `import:${source.providerInstanceId}:${source.providerSessionId}`,
      );
      const runtimePayload = { cwd: "/tmp/project", activeTurnId: "active-turn" };
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claude-current"),
        status: "running",
        resumeCursor: { resume: "current-native-session" },
        runtimePayload,
      });
      const before = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));

      yield* directory.recordImportedTranscript({ threadId, source });
      const replacement = { ...source, size: 200, mtimeMs: 2_000 };
      yield* directory.recordImportedTranscript({ threadId, source: replacement });
      const secondFile = { ...source, filePath: "/tmp/provider-session-copy.jsonl" };
      yield* directory.recordImportedTranscript({ threadId, source: secondFile });

      expect(Option.getOrThrow(yield* repository.getByThreadId({ threadId }))).toEqual({
        ...before,
        runtimePayload: { ...runtimePayload, importedTranscripts: [replacement, secondFile] },
      });
    }),
  );

  it.effect("does not create a binding when recording an imported transcript", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("import:codex:missing-source-binding");

      yield* directory.recordImportedTranscript({ threadId, source: importedSource });

      expect(Option.isNone(yield* directory.getBinding(threadId))).toBe(true);
    }),
  );

  it.effect("keeps newly recorded sources when a runtime write uses a stale payload", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const firstSource = { ...importedSource, providerSessionId: "stale-source" };
      const threadId = ThreadId.make(
        `import:${firstSource.providerInstanceId}:${firstSource.providerSessionId}`,
      );
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "stopped",
        resumeCursor: { threadId: "original-native-session" },
        runtimePayload: { cwd: "/tmp/stale-source-project" },
      });
      yield* directory.recordImportedTranscript({ threadId, source: firstSource });
      const stale = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      const secondSource = { ...firstSource, filePath: "/tmp/stale-source-copy.jsonl" };
      yield* directory.recordImportedTranscript({ threadId, source: secondSource });

      yield* repository.upsert({
        ...stale,
        status: "running",
        resumeCursor: { threadId: "new-native-session" },
        lastSeenAt: "2026-08-24T10:00:00.000Z",
      });

      expect(Option.getOrThrow(yield* repository.getByThreadId({ threadId }))).toEqual({
        ...stale,
        status: "running",
        resumeCursor: { threadId: "new-native-session" },
        lastSeenAt: "2026-08-24T10:00:00.000Z",
        runtimePayload: {
          cwd: "/tmp/stale-source-project",
          importedTranscripts: [firstSource, secondSource],
        },
      });
    }),
  );

  it.effect("reserves imported source records for the atomic recording method", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      for (const onConflict of ["update", "ignore"] as const) {
        const source = { ...importedSource, providerSessionId: `reserved-source-${onConflict}` };
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        const binding = {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        };
        yield* directory.upsert(
          { ...binding, runtimePayload: { cwd: "/tmp/project", importedTranscripts: [source] } },
          { onConflict },
        );
        expect(Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload).toEqual({
          cwd: "/tmp/project",
        });

        yield* directory.recordImportedTranscript({ threadId, source });
        yield* directory.upsert({ ...binding, runtimePayload: null });

        expect(Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload).toEqual({
          importedTranscripts: [source],
        });
      }
    }),
  );

  it.effect("lists persisted bindings with metadata in oldest-first order", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const olderThreadId = ThreadId.make("thread-runtime-older");
      const newerThreadId = ThreadId.make("thread-runtime-newer");

      yield* runtimeRepository.upsert({
        threadId: newerThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T12:05:00.000Z",
        resumeCursor: {
          opaque: "resume-newer",
        },
        runtimePayload: {
          cwd: "/tmp/newer",
        },
      });

      yield* runtimeRepository.upsert({
        threadId: olderThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "approval-required",
        status: "starting",
        lastSeenAt: "2026-04-14T12:00:00.000Z",
        resumeCursor: {
          opaque: "resume-older",
        },
        runtimePayload: {
          cwd: "/tmp/older",
        },
      });

      const bindings = (yield* directory.listBindings()).filter(
        (binding) => binding.threadId === olderThreadId || binding.threadId === newerThreadId,
      );

      assert.deepEqual(bindings, [
        {
          threadId: olderThreadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          adapterKey: "claudeAgent",
          runtimeMode: "approval-required",
          status: "starting",
          lastSeenAt: "2026-04-14T12:00:00.000Z",
          resumeCursor: {
            opaque: "resume-older",
          },
          runtimePayload: {
            cwd: "/tmp/older",
          },
        },
        {
          threadId: newerThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: "2026-04-14T12:05:00.000Z",
          resumeCursor: {
            opaque: "resume-newer",
          },
          runtimePayload: {
            cwd: "/tmp/newer",
          },
        },
      ]);
    }),
  );

  it.effect(
    "resets adapterKey to the new provider when provider changes without an explicit adapter key",
    () =>
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const threadId = ThreadId.make("thread-provider-change");

        yield* runtimeRepository.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: null,
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          resumeCursor: null,
          runtimePayload: null,
        });

        yield* directory.upsert({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
        });

        const runtime = yield* runtimeRepository.getByThreadId({ threadId });
        assert.equal(Option.isSome(runtime), true);
        if (Option.isSome(runtime)) {
          assert.equal(runtime.value.providerName, "codex");
          assert.equal(runtime.value.adapterKey, "codex");
        }
      }),
  );

  it.effect("rehydrates persisted mappings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-directory-"));
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      const threadId = ThreadId.make("thread-restart");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        const provider = yield* directory.getProvider(threadId);
        assert.equal(provider, "codex");

        const resolvedBinding = yield* directory.getBinding(threadId);
        expect(Option.getOrThrow(resolvedBinding)).toMatchObject({
          threadId,
          provider: ProviderDriverKind.make("codex"),
        });
        if (Option.isSome(resolvedBinding)) {
          assert.equal(resolvedBinding.value.threadId, threadId);
        }

        const legacyTableRows = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'provider_sessions'
        `;
        assert.equal(legacyTableRows.length, 0);
      }).pipe(Effect.provide(directoryLayer));

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }),
  );
});
