import { AuthStandardClientScopes } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

// v0.0.45 AuthStandardClientScopes.
const preSplitScopes = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
];
const earlierRevokedAt = "2026-10-01T00:00:00.000Z";

const sessions = [
  {
    id: "pre-split",
    subject: "cloud-connect",
    method: "dpop-access-token",
    scopes: preSplitScopes,
  },
  {
    id: "pre-split-reordered",
    subject: "cloud-connect",
    method: "dpop-access-token",
    scopes: preSplitScopes.toReversed(),
  },
  {
    id: "pre-split-revoked",
    subject: "cloud-connect",
    method: "dpop-access-token",
    scopes: preSplitScopes,
    revokedAt: earlierRevokedAt,
  },
  {
    id: "narrowed-four",
    subject: "cloud-connect",
    method: "dpop-access-token",
    scopes: preSplitScopes.filter((scope) => scope !== "review:write"),
  },
  {
    id: "narrowed-two",
    subject: "cloud-connect",
    method: "dpop-access-token",
    scopes: ["orchestration:read", "relay:read"],
  },
  {
    id: "current-standard",
    subject: "cloud-connect",
    method: "dpop-access-token",
    scopes: AuthStandardClientScopes,
  },
  {
    id: "paired-pre-split",
    subject: "one-time-token",
    method: "dpop-access-token",
    scopes: preSplitScopes,
  },
  {
    id: "cloud-bearer-pre-split",
    subject: "cloud-connect",
    method: "bearer-access-token",
    scopes: preSplitScopes,
  },
] as const;

layer("090_RevokePreSplitCloudConnectSessions", (it) => {
  it.effect("revokes only active pre-split T3 Connect DPoP sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });

      for (const session of sessions) {
        yield* sql`
          INSERT INTO auth_sessions (
            session_id, subject, scopes, method, issued_at, expires_at, revoked_at
          )
          VALUES (
            ${session.id}, ${session.subject}, ${JSON.stringify(session.scopes)}, ${session.method},
            '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z',
            ${"revokedAt" in session ? session.revokedAt : null}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 90 });

      const rows = yield* sql<{ readonly id: string; readonly revokedAt: string | null }>`
        SELECT session_id AS "id", revoked_at AS "revokedAt" FROM auth_sessions
      `;
      const revokedAt = new Map(rows.map((row) => [row.id, row.revokedAt]));
      assert.isNotNull(revokedAt.get("pre-split"));
      assert.isNotNull(revokedAt.get("pre-split-reordered"));
      assert.strictEqual(revokedAt.get("pre-split-revoked"), earlierRevokedAt);
      for (const id of [
        "narrowed-four",
        "narrowed-two",
        "current-standard",
        "paired-pre-split",
        "cloud-bearer-pre-split",
      ]) {
        assert.isNull(revokedAt.get(id), id);
      }
    }),
  );
});
