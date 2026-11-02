import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export const AuthTailnetDeviceBlockRecord = Schema.Struct({
  stableNodeId: Schema.String,
  label: Schema.NullOr(Schema.String),
  blockedAt: Schema.DateTimeUtcFromString,
});
export type AuthTailnetDeviceBlockRecord = typeof AuthTailnetDeviceBlockRecord.Type;

const StableNodeIdInput = Schema.Struct({ stableNodeId: Schema.String });

export type AuthTailnetDeviceBlockRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/** Devices refused for Tailscale sign-in. Pairing grant consumption reads this table too. */
export class AuthTailnetDeviceBlockRepository extends Context.Service<
  AuthTailnetDeviceBlockRepository,
  {
    /** Keeps the first block time when the device is already blocked. */
    readonly block: (
      input: AuthTailnetDeviceBlockRecord,
    ) => Effect.Effect<void, AuthTailnetDeviceBlockRepositoryError>;
    readonly unblock: (input: {
      readonly stableNodeId: string;
    }) => Effect.Effect<boolean, AuthTailnetDeviceBlockRepositoryError>;
    readonly isBlocked: (input: {
      readonly stableNodeId: string;
    }) => Effect.Effect<boolean, AuthTailnetDeviceBlockRepositoryError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<AuthTailnetDeviceBlockRecord>,
      AuthTailnetDeviceBlockRepositoryError
    >;
  }
>()("t3/persistence/AuthTailnetDeviceBlocks/AuthTailnetDeviceBlockRepository") {}

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): AuthTailnetDeviceBlockRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertBlock = SqlSchema.void({
    Request: AuthTailnetDeviceBlockRecord,
    execute: (input) => sql`
      INSERT INTO auth_tailnet_device_blocks (stable_node_id, label, blocked_at)
      VALUES (${input.stableNodeId}, ${input.label}, ${input.blockedAt})
      ON CONFLICT(stable_node_id) DO NOTHING
    `,
  });

  const deleteBlock = SqlSchema.findAll({
    Request: StableNodeIdInput,
    Result: StableNodeIdInput,
    execute: ({ stableNodeId }) => sql`
      DELETE FROM auth_tailnet_device_blocks
      WHERE stable_node_id = ${stableNodeId}
      RETURNING stable_node_id AS "stableNodeId"
    `,
  });

  const findBlock = SqlSchema.findOneOption({
    Request: StableNodeIdInput,
    Result: StableNodeIdInput,
    execute: ({ stableNodeId }) => sql`
      SELECT stable_node_id AS "stableNodeId"
      FROM auth_tailnet_device_blocks
      WHERE stable_node_id = ${stableNodeId}
    `,
  });

  const listBlocks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AuthTailnetDeviceBlockRecord,
    execute: () => sql`
      SELECT
        stable_node_id AS "stableNodeId",
        label AS "label",
        blocked_at AS "blockedAt"
      FROM auth_tailnet_device_blocks
      ORDER BY blocked_at DESC, stable_node_id
    `,
  });

  const block: AuthTailnetDeviceBlockRepository["Service"]["block"] = (input) =>
    insertBlock(input).pipe(
      Effect.mapError(toRepositoryError("AuthTailnetDeviceBlockRepository.block")),
    );

  const unblock: AuthTailnetDeviceBlockRepository["Service"]["unblock"] = (input) =>
    deleteBlock(input).pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toRepositoryError("AuthTailnetDeviceBlockRepository.unblock")),
    );

  const isBlocked: AuthTailnetDeviceBlockRepository["Service"]["isBlocked"] = (input) =>
    findBlock(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.map(Option.isSome),
      Effect.mapError(toRepositoryError("AuthTailnetDeviceBlockRepository.isBlocked")),
    );

  const list: AuthTailnetDeviceBlockRepository["Service"]["list"] = () =>
    listBlocks(undefined).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toRepositoryError("AuthTailnetDeviceBlockRepository.list")),
    );

  return AuthTailnetDeviceBlockRepository.of({ block, unblock, isBlocked, list });
});

export const layer = Layer.effect(AuthTailnetDeviceBlockRepository, make);
