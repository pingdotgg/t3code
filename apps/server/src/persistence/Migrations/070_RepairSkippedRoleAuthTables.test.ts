import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "070_RepairSkippedRoleAuthTables",
  (it) => {
    it.effect(
      "repairs scope-only auth tables after the ledger advanced past their migrations",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* runMigrations({ toMigrationInclusive: 69 });
          yield* sql`DROP TABLE auth_pairing_links`;
          yield* sql`DROP TABLE auth_sessions`;
          yield* sql`
          CREATE TABLE auth_pairing_links (
            id TEXT PRIMARY KEY,
            credential TEXT NOT NULL UNIQUE,
            method TEXT NOT NULL,
            scopes TEXT NOT NULL,
            subject TEXT NOT NULL,
            label TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            revoked_at TEXT
          )
        `;
          yield* sql`
          CREATE TABLE auth_sessions (
            session_id TEXT PRIMARY KEY,
            subject TEXT NOT NULL,
            scopes TEXT NOT NULL,
            method TEXT NOT NULL,
            client_label TEXT,
            client_ip_address TEXT,
            client_user_agent TEXT,
            client_device_type TEXT NOT NULL DEFAULT 'unknown',
            client_os TEXT,
            client_browser TEXT,
            issued_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            last_connected_at TEXT,
            revoked_at TEXT
          )
        `;

          yield* runMigrations({ toMigrationInclusive: 70 });

          const pairingColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(auth_pairing_links)
        `;
          const sessionColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(auth_sessions)
        `;

          assert.isTrue(pairingColumns.some((column) => column.name === "role"));
          assert.isTrue(pairingColumns.some((column) => column.name === "scopes"));
          assert.isTrue(sessionColumns.some((column) => column.name === "role"));
          assert.isTrue(sessionColumns.some((column) => column.name === "scopes"));
        }),
    );
  },
);
