import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowWebhook, type WorkflowWebhookShape } from "../Services/WorkflowWebhook.ts";

// Dedup-row retention. A delivery row only exists to answer "have I seen this
// deliveryId before?" for a sender's bounded retry window — well past it the row
// is dead weight. Without this sweep every successful keyed delivery leaves a
// permanent row and the table grows unbounded for the life of a board (the
// created_at column from migration 033 exists precisely for time-based pruning).
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DEFAULT_MAX_DELETES_PER_SWEEP = 5_000; // bound per-sweep work / lock hold

export interface WorkflowWebhookLiveOptions {
  readonly retentionMs?: number;
  readonly pruneIntervalMs?: number;
  readonly maxDeletesPerSweep?: number;
}

const toWebhookError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "workflow webhook store failed", cause });

const wrap = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toWebhookError));

const hashToken = (token: string): string => NodeCrypto.createHash("sha256").update(token).digest("hex");

export const workflowWebhookPath = (boardId: string): string =>
  `/hooks/workflow/${encodeURIComponent(boardId)}`;

const make = (options?: WorkflowWebhookLiveOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

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
          FROM workflow_board_webhook
          WHERE board_id = ${boardId}
        `);
        const existing = rows[0];
        if (existing !== undefined && !rotate) {
          return {
            path: workflowWebhookPath(boardId as string),
            hasToken: true,
            tokenPrefix: existing.tokenPrefix,
          };
        }
        const token = NodeCrypto.randomBytes(32).toString("hex");
        const tokenPrefix = token.slice(0, 8);
        const createdAt = yield* nowIso;
        yield* wrap(sql`
          INSERT INTO workflow_board_webhook (board_id, token_hash, token_prefix, created_at)
          VALUES (${boardId}, ${hashToken(token)}, ${tokenPrefix}, ${createdAt})
          ON CONFLICT(board_id) DO UPDATE SET
            token_hash = excluded.token_hash,
            token_prefix = excluded.token_prefix,
            created_at = excluded.created_at
        `);
        return {
          path: workflowWebhookPath(boardId as string),
          hasToken: true,
          tokenPrefix,
          token,
        };
      });

    const verifyToken: WorkflowWebhookShape["verifyToken"] = (boardId, token) =>
      Effect.gen(function* () {
        const rows = yield* wrap(sql<{ readonly tokenHash: string }>`
          SELECT token_hash AS "tokenHash"
          FROM workflow_board_webhook
          WHERE board_id = ${boardId}
        `);
        const stored = rows[0]?.tokenHash;
        if (stored === undefined) {
          return false;
        }
        const expected = Buffer.from(stored, "hex");
        const candidate = Buffer.from(hashToken(token), "hex");
        return expected.length === candidate.length && NodeCrypto.timingSafeEqual(expected, candidate);
      });

    const recordDelivery: WorkflowWebhookShape["recordDelivery"] = (boardId, deliveryId) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        // RETURNING yields a row ONLY when the insert actually happened. A fresh
        // id inserts → returns the row → false (proceed to ingest). A repeat id
        // hits ON CONFLICT DO NOTHING → no row → true (duplicate, skip). Across
        // two concurrent same-id requests exactly one wins the INSERT and gets
        // false; the loser sees the conflict and gets true — no double-ingest.
        const inserted = yield* wrap(sql<{ readonly deliveryId: string }>`
          INSERT INTO workflow_webhook_delivery (board_id, delivery_id, created_at)
          VALUES (${boardId}, ${deliveryId}, ${createdAt})
          ON CONFLICT(board_id, delivery_id) DO NOTHING
          RETURNING delivery_id AS "deliveryId"
        `);
        return inserted.length === 0;
      });

    const releaseDelivery: WorkflowWebhookShape["releaseDelivery"] = (boardId, deliveryId) =>
      wrap(sql`
        DELETE FROM workflow_webhook_delivery
        WHERE board_id = ${boardId} AND delivery_id = ${deliveryId}
      `).pipe(Effect.asVoid);

    const deleteForBoard: WorkflowWebhookShape["deleteForBoard"] = (boardId) =>
      Effect.gen(function* () {
        yield* wrap(sql`DELETE FROM workflow_webhook_delivery WHERE board_id = ${boardId}`);
        yield* wrap(sql`DELETE FROM workflow_board_webhook WHERE board_id = ${boardId}`);
      });

    // Reap dedup rows older than the retention window. Bounded per sweep via an
    // (board_id, delivery_id) IN (SELECT ... LIMIT) subquery so a large backlog
    // is drained over several ticks rather than one long lock-holding DELETE.
    // Returns the deleted count so a sweep can keep going while a batch was full.
    const pruneStaleDeliveries: WorkflowWebhookShape["pruneStaleDeliveries"] = (beforeIso) =>
      Effect.gen(function* () {
        const deleted = yield* wrap(sql<{ readonly deliveryId: string }>`
          DELETE FROM workflow_webhook_delivery
          WHERE (board_id, delivery_id) IN (
            SELECT board_id, delivery_id
            FROM workflow_webhook_delivery
            WHERE created_at < ${beforeIso}
            ORDER BY created_at ASC
            LIMIT ${maxDeletesPerSweep}
          )
          RETURNING delivery_id AS "deliveryId"
        `);
        return deleted.length;
      });

    // One prune pass: compute the cutoff once, then drain full batches until a
    // batch comes back short (backlog exhausted) so a large accumulation is
    // cleared promptly without a single unbounded DELETE.
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
          // A select/DELETE failure is logged and swallowed so a transient store
          // error never tears down the prune loop; the next tick retries.
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
