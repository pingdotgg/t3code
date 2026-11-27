import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { createAttachmentId, createPendingAttachmentId } from "../attachmentStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import { makeThreadAttachmentAccess } from "./threadAttachmentAccess.ts";

it.effect("resolves thread and fork attachment ownership including extracted sidecars", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const access = makeThreadAttachmentAccess({ sql, fileSystem, attachmentsDir: dir });
    yield* runMigrations();

    const attach = Effect.fnUntraced(function* (
      thread: string,
      run: string | null,
      extension = "docx",
    ) {
      const id = createAttachmentId(thread, extension)!;
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${id}, ${thread}, ${run}, 'user', 0, '2025-03-01', '2025-03-01', ${JSON.stringify({ attachments: [{ id }] })})`;
      const file = path.join(dir, `${id}.${extension}${extension === "docx" ? ".txt" : ""}`);
      yield* fileSystem.writeFileString(file, "content");
      return file;
    });

    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json) VALUES
      ('rolled-before', 'parent', 1, 'test', 'rolled_back', '2025-01-01', '2025-02-01', '{}'),
      ('held', 'parent', 2, 'test', 'queued', '2025-01-01', NULL, '{}'),
      ('cancelled-held', 'parent', 3, 'test', 'cancelled', '2025-01-01', '2025-01-02', '{}'),
      ('boundary', 'parent', 4, 'test', 'completed', '2025-01-01', NULL, '{"startedAt":"2025-01-01T00:00:00Z"}'),
      ('later', 'parent', 5, 'test', 'completed', '2025-04-01', NULL, '{"startedAt":"2025-04-01T00:00:00Z"}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
      VALUES ('attempt-cancelled-held', 'parent', 'cancelled-held', 1, 'node-1', 'test', 'pt-1', 'cancelled', '{}')`;
    const included = yield* attach("parent", "boundary");
    const rolledBefore = yield* attach("parent", "rolled-before");
    const later = yield* attach("parent", "later");
    const held = yield* attach("parent", "held");
    const cancelledHeld = yield* attach("parent", "cancelled-held");
    const childOwn = yield* attach("child", null, "png");

    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json, fork_run_ids_json)
      VALUES
      ('child', 'p', 'child', 'test', 'auto', 'default', '2025-03-01', '2025-03-01',
        '{"forkedFrom":{"type":"run","threadId":"parent","runId":"boundary"}}', '["boundary","held","cancelled-held"]'),
      ('side', 'p', 'side', 'test', 'auto', 'default', '2025-03-01', '2025-03-01',
        '{"forkedFrom":{"type":"run","threadId":"parent","runId":"boundary"},"lineage":{"sideChat":true}}', '["boundary"]')`;

    const check = (thread: string, file: string) => access(ThreadId.make(thread), file);
    assert.isTrue(yield* check("parent", included));
    assert.isTrue(yield* check("parent", later));
    assert.isFalse(yield* check("parent", rolledBefore));
    assert.isTrue(yield* check("child", included));
    assert.isTrue(yield* check("child", childOwn));
    assert.isFalse(yield* check("child", later));
    assert.isFalse(yield* check("child", held));
    assert.isFalse(yield* check("child", cancelledHeld));
    assert.isFalse(yield* check("side", included));
    assert.isFalse(yield* check("unrelated", included));

    // Draining a held run renumbers it past the fork boundary; the older fork still cannot read it.
    yield* sql`UPDATE orchestration_v2_projection_runs
      SET ordinal = 6, status = 'starting', payload_json = '{"startedAt":"2025-05-01T00:00:00Z"}'
      WHERE run_id = 'held'`;
    assert.isFalse(yield* check("child", held));

    // Rolling back an undelivered cancelled run keeps it hidden from the fork, while a delivered
    // run rolled back after the fork stays readable to the fork.
    yield* sql`UPDATE orchestration_v2_projection_runs
      SET status = 'rolled_back', completed_at = '2025-05-02'
      WHERE run_id IN ('cancelled-held', 'boundary')`;
    assert.isFalse(yield* check("child", cancelledHeld));
    assert.isTrue(yield* check("child", included));

    const htmlId = createAttachmentId("parent", "html")!;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${htmlId}, 'parent', 'boundary', 1, 'dynamic_tool', 'completed', '2025-03-01',
        ${JSON.stringify({ toolName: "html_render", output: { htmlRender: { attachmentId: htmlId, title: "Page", height: 300 } } })})`;
    const htmlFile = path.join(dir, `${htmlId}.html`);
    yield* fileSystem.writeFileString(htmlFile, "<html/>");
    assert.isTrue(yield* check("child", htmlFile));

    const pendingId = createPendingAttachmentId("txt");
    const pendingFile = path.join(dir, `${pendingId}.txt`);
    yield* fileSystem.writeFileString(pendingFile, "pending");
    assert.isFalse(yield* check("parent", pendingFile));
  }).pipe(
    Effect.provide(
      Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  ),
);

it.effect("fails closed on SQL errors and wires cleanly into live ProviderHost", () =>
  Effect.gen(function* () {
    const host = yield* ProviderHost.ProviderHost;
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const missingDbAccess = makeThreadAttachmentAccess({
      sql,
      fileSystem,
      attachmentsDir: host.paths.attachmentsDir,
    });
    const id = createAttachmentId("parent", "txt")!;
    const file = path.join(host.paths.attachmentsDir, `${id}.txt`);
    yield* fileSystem.writeFileString(file, "hello");
    assert.isFalse(yield* missingDbAccess(ThreadId.make("parent"), file));

    yield* runMigrations();
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('m', 'parent', 'user', 0, '2025-01-01', '2025-01-01', ${JSON.stringify({ attachments: [{ id }] })})`;
    assert.isTrue(yield* host.canReadThreadAttachment!(ThreadId.make("parent"), file));
    assert.isFalse(yield* host.canReadThreadAttachment!(ThreadId.make("other"), file));
  }).pipe(
    Effect.provide(
      ProviderHostLive.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            ServerSettings.layerTest(),
            ServerSecretStore.layer,
          ),
        ),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-host-test-" }),
        ),
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
