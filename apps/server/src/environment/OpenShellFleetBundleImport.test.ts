import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import Migration0083 from "../persistence/Migrations/083_FleetDrainImports.ts";
import * as OpenShellFleetBundleImport from "./OpenShellFleetBundleImport.ts";

const ENVIRONMENT = "environment:worker";
const DRAIN_ID = "drain:environment:worker:1";

const sha256Hex = (bytes: Uint8Array): string => {
  // Mirrors the sink's hash scheme; a fixed short hex is enough for tests.
  let hash = 0;
  for (const byte of bytes) hash = (hash * 31 + byte) % 16 ** 16;
  return hash.toString(16).padStart(16, "0").repeat(4);
};

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** A minimal wire-format bounded snapshot for one archived-candidate thread. */
const snapshotJson = (input: {
  readonly threadId: string;
  readonly snapshotSequence: number;
  readonly title?: string;
  readonly itemText?: string;
}) => ({
  snapshotSequence: input.snapshotSequence,
  projection: {
    thread: {
      createdBy: "system",
      creationSource: "server",
      id: input.threadId,
      projectId: "project:drain-test",
      title: input.title ?? "Worker thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: "2026-11-06T10:00:00.000Z",
      updatedAt: "2026-11-06T11:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [
      {
        id: "provider-thread:1",
        driver: "codex",
        providerInstanceId: "codex",
        providerSessionId: null,
        appThreadId: input.threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: "codex", nativeId: "native-1", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: "2026-11-06T10:00:00.000Z",
        updatedAt: "2026-11-06T11:00:00.000Z",
      },
    ],
    providerTurns: [],
    runtimeRequests: [],
    messages: [
      {
        createdBy: "user",
        creationSource: "server",
        id: `${input.threadId}:msg:1`,
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "hello from the worker",
        attachments: [],
        streaming: false,
        createdAt: "2026-11-06T10:00:00.000Z",
        updatedAt: "2026-11-06T10:00:00.000Z",
      },
    ],
    plans: [],
    turnItems: [
      {
        id: `${input.threadId}:item:1`,
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: "2026-11-06T10:00:00.000Z",
        completedAt: "2026-11-06T10:00:00.000Z",
        updatedAt: "2026-11-06T10:00:00.000Z",
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        messageId: `${input.threadId}:msg:1`,
        inputIntent: "turn_start",
        text: input.itemText ?? "hello from the worker",
        attachments: [],
      },
    ],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: "2026-11-06T11:00:00.000Z",
  },
  historyCursor: null,
  hasMoreHistory: false,
  latestLocalTurnOrdinal: 1,
});

interface WrittenEvents {
  readonly writes: Array<ReadonlyArray<{ readonly id: string; readonly type: string }>>;
}

interface FakeStoreState {
  readonly rows: Map<string, OpenShellFleetBundleImport.FleetDrainImportRow>;
  readonly exists: Set<string>;
}

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectory();
  const attachmentsDir = yield* fs.makeTempDirectory();
  const written: WrittenEvents["writes"] = [];
  const store: FakeStoreState = { rows: new Map(), exists: new Set() };
  const eventSink = {
    write: (input: { readonly events: ReadonlyArray<{ id: string; type: string }> }) =>
      Effect.sync(() => {
        written.push(input.events);
        return input.events;
      }),
  };
  const importer = OpenShellFleetBundleImport.makeFleetBundleImporter({
    stateDir,
    attachmentsDir,
    fs,
    path,
    now: Effect.succeed(1_700_000_000_000),
    eventSink: eventSink as never,
    store: {
      find: (threadId) => Effect.succeed(store.rows.get(threadId) ?? null),
      threadExists: (threadId) => Effect.succeed(store.exists.has(threadId)),
      record: (row) =>
        Effect.sync(() => {
          store.rows.set(row.threadId, row);
          store.exists.add(row.threadId);
        }),
    },
  });
  const writeBundle = (input: {
    readonly threadId: string;
    readonly snapshotSequence: number;
    readonly title?: string;
    readonly attachments?: ReadonlyArray<{ name: string; bytes: string }>;
    readonly attachmentsSkipped?: boolean;
  }) =>
    Effect.gen(function* () {
      const snapshot = snapshotJson(input);
      const manifest = (input.attachments ?? []).map((file) => {
        const bytes = new TextEncoder().encode(
          Buffer.from(file.bytes, "base64").toString("binary"),
        );
        return { name: file.name, hash: sha256Hex(bytes), size: bytes.byteLength };
      });
      const dir = path.join(
        stateDir,
        "fleet-drain",
        encodeURIComponent(ENVIRONMENT),
        encodeURIComponent(DRAIN_ID),
      );
      yield* fs.makeDirectory(dir, { recursive: true });
      for (const [index, file] of (input.attachments ?? []).entries()) {
        yield* fs.writeFile(
          path.join(
            dir,
            `thread-${encodeURIComponent(input.threadId)}-att-${manifest[index]?.hash.slice(0, 16)}.bin`,
          ),
          Buffer.from(file.bytes, "base64"),
        );
      }
      yield* fs.writeFileString(
        path.join(dir, `thread-${encodeURIComponent(input.threadId)}.json`),
        JSON.stringify({
          threadId: input.threadId,
          snapshot,
          pages: [],
          ...(manifest.length > 0 ? { attachments: manifest } : {}),
          ...(input.attachmentsSkipped === true ? { attachmentsSkipped: true } : {}),
        }),
      );
    });
  return {
    importer,
    written,
    store,
    stateDir,
    attachmentsDir,
    fs,
    path,
    writeBundle,
  };
});

const eventTypes = (written: WrittenEvents["writes"]) =>
  written.flatMap((batch) => batch.map((event) => event.type));

const importedThreadIds = (written: WrittenEvents["writes"]) =>
  written.flatMap((batch) =>
    batch.filter((event) => event.type === "thread.created").map((event) => event.id),
  );

describe("fleet bundle import", () => {
  it.effect("imports a drained thread as an archived thread with a visible marker", () =>
    Effect.gen(function* () {
      const { importer, written, store, writeBundle } = yield* harness;
      yield* writeBundle({ threadId: "thread:a", snapshotSequence: 3 });

      const result = yield* importer.importBundle({
        environmentId: ENVIRONMENT,
        drainId: DRAIN_ID,
      });

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(eventTypes(written)).toContain("thread.created");
      expect(eventTypes(written)).toContain("turn-item.updated");
      expect(eventTypes(written)).toContain("message.updated");
      expect(eventTypes(written)).toContain("provider-thread.updated");
      const head = written
        .flatMap((batch) => batch)
        .find((event) => event.type === "thread.created") as unknown as {
        payload: { archivedAt: string | null; title: string; tags?: ReadonlyArray<string> };
      };
      expect(head.payload.archivedAt).not.toBeNull();
      expect(head.payload.title).toContain("(drained from environment:worker)");
      expect(head.payload.tags).toContain("fleet-drain:environment:worker");
      expect(store.rows.get("thread:a")?.snapshotSequence).toBe(3);
      expect(store.rows.get("thread:a")?.drainId).toBe(DRAIN_ID);
      expect(importedThreadIds(written)).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the same threadId and snapshotSequence imports only once", () =>
    Effect.gen(function* () {
      const { importer, written, writeBundle } = yield* harness;
      yield* writeBundle({ threadId: "thread:a", snapshotSequence: 3 });
      yield* importer.importBundle({ environmentId: ENVIRONMENT, drainId: DRAIN_ID });
      const firstCount = written.flat().length;

      const again = yield* importer.importBundle({
        environmentId: ENVIRONMENT,
        drainId: DRAIN_ID,
      });

      expect(again.imported).toBe(0);
      expect(again.skipped).toBe(1);
      // No new events and no duplicate thread creation.
      expect(written.flat().length).toBe(firstCount);
      expect(importedThreadIds(written)).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a changed snapshotSequence supersedes the previous import", () =>
    Effect.gen(function* () {
      const { importer, written, store, writeBundle } = yield* harness;
      yield* writeBundle({ threadId: "thread:a", snapshotSequence: 3, title: "Before" });
      yield* importer.importBundle({ environmentId: ENVIRONMENT, drainId: DRAIN_ID });
      yield* writeBundle({ threadId: "thread:a", snapshotSequence: 9, title: "After" });
      written.length = 0;

      const result = yield* importer.importBundle({
        environmentId: ENVIRONMENT,
        drainId: DRAIN_ID,
      });

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      // The thread shell is refreshed, not re-created.
      expect(eventTypes(written)).not.toContain("thread.created");
      expect(eventTypes(written)).toContain("thread.metadata-updated");
      expect(eventTypes(written)).toContain("turn-item.updated");
      const head = written
        .flatMap((batch) => batch)
        .find((event) => event.type === "thread.metadata-updated") as unknown as {
        payload: { title: string };
      };
      expect(head.payload.title).toContain("After");
      expect(store.rows.get("thread:a")?.snapshotSequence).toBe(9);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never overwrites a local thread that was not drain-imported", () =>
    Effect.gen(function* () {
      const { importer, written, store, writeBundle } = yield* harness;
      store.exists.add("thread:local");
      yield* writeBundle({ threadId: "thread:local", snapshotSequence: 1 });

      const result = yield* importer.importBundle({
        environmentId: ENVIRONMENT,
        drainId: DRAIN_ID,
      });

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(written).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a broken bundle warns and never fails the whole import", () =>
    Effect.gen(function* () {
      const { importer, written, stateDir, fs, path, writeBundle } = yield* harness;
      yield* writeBundle({ threadId: "thread:a", snapshotSequence: 1 });
      yield* fs.writeFileString(
        path.join(
          stateDir,
          "fleet-drain",
          encodeURIComponent(ENVIRONMENT),
          encodeURIComponent(DRAIN_ID),
          "thread-broken.json",
        ),
        '{"threadId":"thread:broken"}',
      );

      const result = yield* importer.importBundle({
        environmentId: ENVIRONMENT,
        drainId: DRAIN_ID,
      });

      expect(result.imported).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(written.flat().length).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("attachment restore", () => {
  it.effect("restores manifest attachments under the thread's own segment", () =>
    Effect.gen(function* () {
      const { importer, store, attachmentsDir, fs, writeBundle } = yield* harness;
      yield* writeBundle({
        threadId: "thread:a",
        snapshotSequence: 2,
        attachments: [{ name: "shot.png", bytes: base64("png-bytes") }],
      });

      const result = yield* importer.importBundle({
        environmentId: ENVIRONMENT,
        drainId: DRAIN_ID,
      });

      expect(result.imported).toBe(1);
      const segment = toSafeThreadAttachmentSegment("thread:a");
      const restored = yield* fs.readFile(`${attachmentsDir}/${segment}/shot.png`);
      expect(new TextDecoder().decode(restored)).toBe("png-bytes");
      expect(store.rows.get("thread:a")?.oversizeAttachmentsSkipped).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records an oversize skip in the import marker", () =>
    Effect.gen(function* () {
      const { importer, store, writeBundle } = yield* harness;
      yield* writeBundle({
        threadId: "thread:big",
        snapshotSequence: 2,
        attachmentsSkipped: true,
      });

      const result = yield* importer.importBundle({
        environmentId: ENVIRONMENT,
        drainId: DRAIN_ID,
      });

      expect(result.imported).toBe(1);
      expect(store.rows.get("thread:big")?.oversizeAttachmentsSkipped).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("sqlite import store", () => {
  it.effect("round-trips rows and supersedes on conflict", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(Sqlite.layerMemory);
      const sql = Context.get(context, SqlClient.SqlClient);
      yield* Migration0083.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const store = OpenShellFleetBundleImport.sqliteFleetDrainImportStore(sql);

      expect(yield* store.find("thread:x")).toBeNull();
      yield* store.record({
        threadId: "thread:x",
        environmentId: ENVIRONMENT,
        drainId: DRAIN_ID,
        snapshotSequence: 4,
        importedAt: "2026-11-06T10:00:00.000Z",
        oversizeAttachmentsSkipped: true,
      });
      const row = yield* store.find("thread:x");
      expect(row).toMatchObject({
        threadId: "thread:x",
        environmentId: ENVIRONMENT,
        drainId: DRAIN_ID,
        snapshotSequence: 4,
        oversizeAttachmentsSkipped: true,
      });
      expect(yield* store.threadExists("thread:x")).toBe(false);

      yield* store.record({
        threadId: "thread:x",
        environmentId: ENVIRONMENT,
        drainId: "drain:environment:worker:2",
        snapshotSequence: 5,
        importedAt: "2026-11-06T12:00:00.000Z",
        oversizeAttachmentsSkipped: false,
      });
      expect(yield* store.find("thread:x")).toMatchObject({
        snapshotSequence: 5,
        drainId: "drain:environment:worker:2",
        oversizeAttachmentsSkipped: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
