import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../Migrations.ts";

const fresh = Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }));

const LIVE = "2999-01-01T00:00:00.000Z";
const EXPIRED = "2000-01-01T00:00:00.000Z";
const FULL = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "source-control:write",
];

const fixtures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const link = (id: string, label: string, origin: string, expiresAt = LIVE) => sql`
    INSERT INTO peer_environment_links
      (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, origin)
    VALUES (${id}, ${`peer-${id}`}, ${label}, '[]', 'full-access',
      '2026-11-01T00:00:00.000Z', ${expiresAt}, ${origin})
  `;
  const session = (
    id: string,
    peer: string,
    scopes: ReadonlyArray<string>,
    expiresAt = LIVE,
  ) => sql`
    INSERT INTO auth_sessions
      (session_id, subject, scopes, method, issued_at, expires_at, peer_environment_id)
    VALUES (${id}, 'mcp-client', ${JSON.stringify(scopes)}, 'bearer-access-token',
      '2026-11-01T00:00:00.000Z', ${expiresAt}, ${peer})
  `;
  const members = sql<{
    readonly environment_id: string;
    readonly label: string;
    readonly node_id: string | null;
    readonly access: string;
    readonly stamp_json: string;
  }>`SELECT * FROM network_members ORDER BY environment_id`.pipe(
    Effect.map((rows) =>
      rows.map((row) => [
        row.environment_id,
        row.label,
        row.node_id,
        row.access,
        JSON.parse(row.stamp_json).wallMs,
      ]),
    ),
  );
  return { sql, link, session, members };
});

describe("fork/022_NetworkContinuity", () => {
  it.effect("machines linked both ways before the update come out as members", () =>
    Effect.gen(function* () {
      // The 0.1.6 shape: pairing-code links each way, no device policy at all.
      yield* runMigrations({ toForkMigrationInclusive: 16 });
      const { sql, link, session, members } = yield* fixtures;
      yield* link("env-mac", "MacBook", "paired");
      yield* session("s-mac", "env-mac", FULL);
      yield* link("env-ro", "Reader", "paired");
      yield* session("s-ro", "env-ro", ["orchestration:read"]);
      // Only one side of a link, an expired one or a revoked session: no trust both ways.
      yield* link("env-oneway", "Outgoing", "paired");
      yield* session("s-incoming", "env-incoming", FULL);
      yield* link("env-expired", "Expired", "paired", EXPIRED);
      yield* session("s-expired", "env-expired", FULL);
      yield* link("env-stale", "Stale", "paired");
      yield* session("s-stale", "env-stale", FULL, EXPIRED);
      // Revoked in the old policy: stays out.
      yield* link("env-revoked", "Revoked", "paired");
      yield* session("s-revoked", "env-revoked", FULL);
      yield* sql`
        INSERT INTO tailnet_device_policy (environment_id, access, stamp_json, updated_by)
        VALUES ('env-revoked', 'revoked', '{"wallMs":9,"counter":0,"node":"env-mac"}', 'env-mac')
      `;
      // A stranger found on the tailnet: never a member without the user adding it.
      yield* sql`
        INSERT INTO tailnet_devices (environment_id, label, urls_json, tailnet_name, last_seen_at)
        VALUES ('env-found', 'Found', '[]', 'found', NULL)
      `;

      yield* runMigrations();

      assert.deepEqual(yield* members, [
        ["env-mac", "MacBook", null, "full-access", 0],
        ["env-revoked", "Revoked", null, "revoked", 9],
        ["env-ro", "Reader", null, "read-only", 0],
      ]);
    }).pipe(fresh),
  );

  it.effect("repairs a roster the update already split, keeping what the user removed", () =>
    Effect.gen(function* () {
      // What 0.1.9 left: a self seed, a member named by its bare id, and one the user forgot.
      yield* runMigrations({ toForkMigrationInclusive: 21 });
      const { sql, link, session, members } = yield* fixtures;
      yield* sql`
        INSERT INTO network_members (environment_id, label, node_id, access, stamp_json, hidden)
        VALUES
          ('env-self', 'Studio', NULL, 'full-access', '{"wallMs":0,"counter":0,"node":"env-self"}', 0),
          ('env-mac', 'env-mac', NULL, 'full-access', '{"wallMs":5,"counter":0,"node":"env-self"}', 0),
          ('env-desk', 'Desktop', NULL, 'revoked', '{"wallMs":7,"counter":0,"node":"env-self"}', 1)
      `;
      yield* sql`
        INSERT INTO tailnet_devices (environment_id, label, urls_json, tailnet_name, last_seen_at)
        VALUES ('env-mac', 'MacBook Pro', '[]', 'macbook', NULL)
      `;
      yield* link("env-desk", "Desktop", "paired");
      yield* session("s-desk", "env-desk", FULL);
      yield* link("env-box", "Dev box", "paired");
      yield* session("s-box", "env-box", FULL);

      yield* runMigrations();

      assert.deepEqual(yield* members, [
        ["env-box", "Dev box", null, "full-access", 0],
        ["env-desk", "Desktop", null, "revoked", 7],
        ["env-mac", "MacBook Pro", null, "full-access", 5],
        ["env-self", "Studio", null, "full-access", 0],
      ]);
    }).pipe(fresh),
  );
});
