// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { BoardId } from "../../../contracts/workflow.ts";
import { workflowWebhookPath } from "../webhookRoute.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowWebhook, type WorkflowWebhookShape } from "../Services/WorkflowWebhook.ts";

const DEFAULT_BASE_PATH = "/hooks/plugins/workflow-boards";
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_DELETES_PER_SWEEP = 5_000;

export interface WorkflowWebhookLiveOptions {
  readonly basePath?: string;
  readonly retentionMs?: number;
  readonly pruneIntervalMs?: number;
  readonly maxDeletesPerSweep?: number;
}

const toWebhookError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "workflow webhook store failed", cause });

const wrap = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toWebhookError));

const hashToken = (token: string): string =>
  NodeCrypto.createHash("sha256").update(token).digest("hex");

const boardIdValue = (boardId: BoardId) => String(boardId);

const make = (options?: WorkflowWebhookLiveOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const basePath = options?.basePath ?? DEFAULT_BASE_PATH;
    const retentionMs = Math.max(1, options?.retentionMs ?? DEFAULT_RETENTION_MS);
    const pruneIntervalMs = Math.max(1, options?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS);
    const maxDeletesPerSweep = Math.max(
      1,
      Math.floor(options?.maxDeletesPerSweep ?? DEFAULT_MAX_DELETES_PER_SWEEP),
    );

    const getConfig: WorkflowWebhookShape["getConfig"] = (boardId, rotate) =>
      Effect.gen(function* () {
        const rows = yield* wrap(sql<{ readonly tokenPrefix: string }>`
          SELECT token_prefix AS "tokenPrefix"
          FROM p_workflow_boards_board_webhook
          WHERE board_id = ${boardIdValue(boardId)}
        `);
        const existing = rows[0];
        if (existing !== undefined && !rotate) {
          return {
            path: workflowWebhookPath(basePath, boardId),
            hasToken: true,
            tokenPrefix: existing.tokenPrefix,
          };
        }

        const token = NodeCrypto.randomBytes(32).toString("hex");
        const tokenPrefix = token.slice(0, 8);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* wrap(sql`
          INSERT INTO p_workflow_boards_board_webhook (board_id, token_hash, token_prefix, created_at)
          VALUES (${boardIdValue(boardId)}, ${hashToken(token)}, ${tokenPrefix}, ${createdAt})
          ON CONFLICT(board_id) DO UPDATE SET
            token_hash = excluded.token_hash,
            token_prefix = excluded.token_prefix,
            created_at = excluded.created_at
        `);
        return {
          path: workflowWebhookPath(basePath, boardId),
          hasToken: true,
          tokenPrefix,
          token,
        };
      });

    const verifyToken: WorkflowWebhookShape["verifyToken"] = (boardId, token) =>
      Effect.gen(function* () {
        const rows = yield* wrap(sql<{ readonly tokenHash: string }>`
          SELECT token_hash AS "tokenHash"
          FROM p_workflow_boards_board_webhook
          WHERE board_id = ${boardIdValue(boardId)}
        `);
        const stored = rows[0]?.tokenHash;
        if (stored === undefined) {
          return false;
        }
        const expected = Buffer.from(stored, "hex");
        const candidate = Buffer.from(hashToken(token), "hex");
        return (
          expected.length === candidate.length && NodeCrypto.timingSafeEqual(expected, candidate)
        );
      });

    const recordDelivery: WorkflowWebhookShape["recordDelivery"] = (boardId, deliveryId) =>
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const inserted = yield* wrap(sql<{ readonly deliveryId: string }>`
          INSERT INTO p_workflow_boards_webhook_delivery (board_id, delivery_id, created_at)
          VALUES (${boardIdValue(boardId)}, ${deliveryId}, ${createdAt})
          ON CONFLICT(board_id, delivery_id) DO NOTHING
          RETURNING delivery_id AS "deliveryId"
        `);
        return inserted.length === 0;
      });

    const releaseDelivery: WorkflowWebhookShape["releaseDelivery"] = (boardId, deliveryId) =>
      wrap(sql`
        DELETE FROM p_workflow_boards_webhook_delivery
        WHERE board_id = ${boardIdValue(boardId)} AND delivery_id = ${deliveryId}
      `).pipe(Effect.asVoid);

    const deleteForBoard: WorkflowWebhookShape["deleteForBoard"] = (boardId) =>
      Effect.gen(function* () {
        yield* wrap(sql`
          DELETE FROM p_workflow_boards_webhook_delivery
          WHERE board_id = ${boardIdValue(boardId)}
        `);
        yield* wrap(sql`
          DELETE FROM p_workflow_boards_board_webhook
          WHERE board_id = ${boardIdValue(boardId)}
        `);
      });

    const pruneStaleDeliveries: WorkflowWebhookShape["pruneStaleDeliveries"] = (beforeIso) =>
      Effect.gen(function* () {
        const deleted = yield* wrap(sql<{ readonly deliveryId: string }>`
          DELETE FROM p_workflow_boards_webhook_delivery
          WHERE (board_id, delivery_id) IN (
            SELECT board_id, delivery_id
            FROM p_workflow_boards_webhook_delivery
            WHERE created_at < ${beforeIso}
            ORDER BY created_at ASC
            LIMIT ${maxDeletesPerSweep}
          )
          RETURNING delivery_id AS "deliveryId"
        `);
        return deleted.length;
      });

    const pruneOnce = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const cutoffIso = DateTime.formatIso(
        DateTime.subtractDuration(now, Duration.millis(retentionMs)),
      );
      let deletedThisPass = 0;
      while (true) {
        const deleted = yield* pruneStaleDeliveries(cutoffIso);
        deletedThisPass += deleted;
        if (deleted < maxDeletesPerSweep) {
          break;
        }
      }
      if (deletedThisPass > 0) {
        yield* Effect.logInfo("workflow.webhook.delivery-pruned", {
          deletedCount: deletedThisPass,
          cutoffIso,
        });
      }
    });

    const start: WorkflowWebhookShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          pruneOnce.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("workflow.webhook.prune-failed", { cause }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(pruneIntervalMs))),
          ),
        );
        yield* Effect.logInfo("workflow.webhook.prune-started", { pruneIntervalMs, retentionMs });
      });

    return {
      getConfig,
      verifyToken,
      recordDelivery,
      releaseDelivery,
      deleteForBoard,
      pruneStaleDeliveries,
      start,
    } satisfies WorkflowWebhookShape;
  });

export const makeWorkflowWebhookLive = (options?: WorkflowWebhookLiveOptions) =>
  Layer.effect(WorkflowWebhook, make(options));

export const WorkflowWebhookLive = makeWorkflowWebhookLive();
