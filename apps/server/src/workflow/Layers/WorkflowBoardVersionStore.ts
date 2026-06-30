import type { BoardId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  WorkflowBoardVersionStore,
  type WorkflowBoardVersionRow,
  type WorkflowBoardVersionStoreShape,
  type WorkflowBoardVersionSummaryRow,
} from "../Services/WorkflowBoardVersionStore.ts";

const toStoreError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrap = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toStoreError(message)));

const boardIdValue = (boardId: BoardId) => String(boardId);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const record: WorkflowBoardVersionStoreShape["record"] = (input) =>
    Effect.gen(function* () {
      const boardId = boardIdValue(input.boardId);
      const newest = yield* wrap(
        "WorkflowBoardVersionStore.record:readNewest",
        sql<{ readonly versionHash: string }>`
          SELECT version_hash AS "versionHash"
          FROM workflow_board_version
          WHERE board_id = ${boardId}
          ORDER BY version_id DESC
          LIMIT 1
        `,
      );
      if (newest[0]?.versionHash === input.versionHash) {
        return;
      }

      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* wrap(
        "WorkflowBoardVersionStore.record:insert",
        sql`
          INSERT INTO workflow_board_version
            (board_id, version_hash, content_json, source, created_at)
          VALUES
            (${boardId}, ${input.versionHash}, ${input.contentJson}, ${input.source}, ${createdAt})
        `,
      );
    });

  const list: WorkflowBoardVersionStoreShape["list"] = (boardId) =>
    wrap(
      "WorkflowBoardVersionStore.list",
      sql<WorkflowBoardVersionSummaryRow>`
        SELECT
          version_id AS "versionId",
          version_hash AS "versionHash",
          source,
          created_at AS "createdAt"
        FROM workflow_board_version
        WHERE board_id = ${boardIdValue(boardId)}
        ORDER BY version_id DESC
      `,
    );

  const get: WorkflowBoardVersionStoreShape["get"] = (boardId, versionId) =>
    wrap(
      "WorkflowBoardVersionStore.get",
      sql<WorkflowBoardVersionRow>`
        SELECT
          version_id AS "versionId",
          version_hash AS "versionHash",
          content_json AS "contentJson",
          source,
          created_at AS "createdAt"
        FROM workflow_board_version
        WHERE board_id = ${boardIdValue(boardId)}
          AND version_id = ${versionId}
        LIMIT 1
      `,
    ).pipe(Effect.map((rows) => rows[0] ?? null));

  const deleteForBoard: WorkflowBoardVersionStoreShape["deleteForBoard"] = (boardId) =>
    wrap(
      "WorkflowBoardVersionStore.deleteForBoard",
      sql`
        DELETE FROM workflow_board_version
        WHERE board_id = ${boardIdValue(boardId)}
      `,
    ).pipe(Effect.asVoid);

  return { record, list, get, deleteForBoard } satisfies WorkflowBoardVersionStoreShape;
});

export const WorkflowBoardVersionStoreLive = Layer.effect(WorkflowBoardVersionStore, make);
