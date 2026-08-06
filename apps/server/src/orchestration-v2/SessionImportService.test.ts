// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ModelSelection, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe } from "vite-plus/test";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { makeLayer as providerAdapterRegistryTestLayer } from "./ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { SessionImportService, layer as sessionImportLayer } from "./SessionImportService.ts";

const codexInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:session-import");
const externalId = "0199a2f8-4e1b-7c3d-9f10-2b6a5d8e4c77";
const modelSelection: ModelSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5.4",
} as ModelSelection;

const fakeCodexAdapter = {
  instanceId: codexInstanceId,
  driver: "codex",
} as unknown as ProviderAdapterV2Shape;

const databaseLayer = SqlitePersistenceMemory;
const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreProvided = projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesProvided));
const sessionImportProvided = sessionImportLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      storesProvided,
      eventSinkProvided,
      providerAdapterRegistryTestLayer([fakeCodexAdapter]),
      idAllocatorLayer,
      NodeServices.layer,
    ),
  ),
);
const TestLayer = Layer.mergeAll(storesProvided, eventSinkProvided, sessionImportProvided);

function rolloutLine(payloadType: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-08-06T09:00:00.000Z",
    type: payloadType,
    payload,
  });
}

describe("SessionImportService", () => {
  const codexHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-home-"));
  const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-import-project-"));
  const rolloutDir = NodePath.join(codexHome, "sessions", "2026", "08", "06");
  NodeFS.mkdirSync(rolloutDir, { recursive: true });
  const rolloutPath = NodePath.join(rolloutDir, `rollout-2026-08-06T09-00-00-${externalId}.jsonl`);
  NodeFS.writeFileSync(
    rolloutPath,
    [
      rolloutLine("session_meta", { id: externalId, cwd: workspaceRoot }),
      rolloutLine("event_msg", { type: "user_message", id: "m1", message: "what is 2+2?" }),
      rolloutLine("event_msg", { type: "agent_message", id: "m2", message: "4" }),
      "",
    ].join("\n"),
  );
  const previousCodexHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = codexHome;
  if (previousCodexHome !== undefined) {
    process.once("beforeExit", () => {
      process.env["CODEX_HOME"] = previousCodexHome;
    });
  }

  it.layer(TestLayer)("session import", (it) => {
    it.effect("imports a codex rollout, resumes it, refuses duplicates, and syncs", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* SessionImportService;
        const projections = yield* ProjectionStoreV2;

        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          ) VALUES (
            ${projectId},
            'Import project',
            ${workspaceRoot},
            '{"instanceId":"codex","model":"gpt-5.4"}',
            '[]',
            '2026-08-01T00:00:00.000Z',
            '2026-08-01T00:00:00.000Z',
            NULL
          )
        `;

        const resolved = yield* service.resolveImportSession({
          instanceId: codexInstanceId,
          externalId,
        });
        assert.strictEqual(resolved.workspaceRoot, workspaceRoot);
        assert.strictEqual(resolved.projectId, projectId);
        assert.strictEqual(resolved.title, "what is 2+2?");

        const imported = yield* service.importSession({
          projectId,
          modelSelection,
          externalId,
        });
        const projection = yield* projections.getThreadProjection(imported.threadId);
        assert.strictEqual(projection.thread.historyOrigin, "provider_import");
        assert.strictEqual(projection.thread.projectId, projectId);
        assert.deepStrictEqual(
          projection.messages.map((message) => [message.role, message.text]),
          [
            ["user", "what is 2+2?"],
            ["assistant", "4"],
          ],
        );
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === projection.thread.activeProviderThreadId,
        );
        assert.isDefined(providerThread);
        assert.strictEqual(providerThread!.nativeThreadRef?.nativeId, externalId);
        assert.strictEqual(providerThread!.nativeThreadRef?.strength, "strong");
        assert.strictEqual(providerThread!.appThreadId, imported.threadId);
        assert.strictEqual(
          projection.visibleTurnItems.filter(
            (row) => row.item.type === "user_message" || row.item.type === "assistant_message",
          ).length,
          2,
        );

        const duplicate = yield* Effect.result(
          service.importSession({ projectId, modelSelection, externalId }),
        );
        assert.strictEqual(duplicate._tag, "Failure");

        // A turn recorded outside T3 shows up after a sync pass.
        NodeFS.appendFileSync(
          rolloutPath,
          `${rolloutLine("event_msg", { type: "user_message", id: "m3", message: "and 3+3?" })}\n${rolloutLine(
            "event_msg",
            { type: "agent_message", id: "m4", message: "6" },
          )}\n`,
        );
        const future = new Date(Date.now() + 5_000);
        NodeFS.utimesSync(rolloutPath, future, future);
        yield* service.ensureSynced(imported.threadId);
        const synced = yield* projections.getThreadProjection(imported.threadId);
        assert.deepStrictEqual(
          synced.messages.map((message) => message.text),
          ["what is 2+2?", "4", "and 3+3?", "6"],
        );
        // Sync is idempotent.
        yield* service.ensureSynced(imported.threadId);
        const resynced = yield* projections.getThreadProjection(imported.threadId);
        assert.strictEqual(resynced.messages.length, 4);

        // A command whose output lands in a later append is backfilled in
        // place on the next sync instead of staying output-less forever.
        NodeFS.appendFileSync(
          rolloutPath,
          `${rolloutLine("response_item", {
            type: "function_call",
            call_id: "c9",
            name: "shell",
            arguments: JSON.stringify({ command: ["echo", "hi"] }),
          })}\n`,
        );
        const later = new Date(Date.now() + 10_000);
        NodeFS.utimesSync(rolloutPath, later, later);
        yield* service.ensureSynced(imported.threadId);
        const withCommand = yield* projections.getThreadProjection(imported.threadId);
        const pendingCommand = withCommand.turnItems.find(
          (item) => item.type === "command_execution" && item.input === "echo hi",
        );
        assert.isDefined(pendingCommand);
        assert.strictEqual(
          pendingCommand?.type === "command_execution" ? pendingCommand.output : "set",
          undefined,
        );

        NodeFS.appendFileSync(
          rolloutPath,
          `${rolloutLine("response_item", {
            type: "function_call_output",
            call_id: "c9",
            output: JSON.stringify({ output: "hi" }),
          })}\n`,
        );
        const evenLater = new Date(Date.now() + 20_000);
        NodeFS.utimesSync(rolloutPath, evenLater, evenLater);
        yield* service.ensureSynced(imported.threadId);
        const backfilled = yield* projections.getThreadProjection(imported.threadId);
        const completedCommand = backfilled.turnItems.find(
          (item) => item.type === "command_execution" && item.input === "echo hi",
        );
        assert.strictEqual(
          completedCommand?.type === "command_execution" ? completedCommand.output : undefined,
          "hi",
        );
        assert.strictEqual(completedCommand?.ordinal, pendingCommand?.ordinal);
      }),
    );

    it.effect("refuses a session that ran in a different workspace", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* SessionImportService;
        const otherProjectId = ProjectId.make("project:elsewhere");
        const otherExternalId = "0199b3c9-5f2c-8d4e-a021-3c7b6e9f5d88";
        NodeFS.writeFileSync(
          NodePath.join(rolloutDir, `rollout-2026-08-06T09-30-00-${otherExternalId}.jsonl`),
          [
            rolloutLine("session_meta", { id: otherExternalId, cwd: workspaceRoot }),
            rolloutLine("event_msg", { type: "user_message", id: "m1", message: "hi" }),
            "",
          ].join("\n"),
        );
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            ${otherProjectId}, 'Elsewhere', '/tmp/definitely-elsewhere',
            '{"instanceId":"codex","model":"gpt-5.4"}', '[]',
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL
          )
        `;
        const result = yield* Effect.result(
          service.importSession({
            projectId: otherProjectId,
            modelSelection,
            externalId: otherExternalId,
          }),
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.include(result.failure.message, "ran in");
        }
      }),
    );
  });
});
