import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const now = "2026-10-08T20:00:00.000Z";
// Minted for a current client by a server from before the split.
const preSplit = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
];
// An older client narrows its request to the scopes it knows.
const narrowedPreSplit = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "relay:read",
];
const standard = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "filesystem:read",
  "filesystem:write",
  "relay:read",
];

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "061_RevokeLegacyCloudConnectSessions",
  (it) => {
    it.effect("revokes only live T3 Connect sessions minted before the scope split", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });
        const insert = (
          id: string,
          subject: string,
          scopes: ReadonlyArray<string>,
          expiresAt: string,
        ) =>
          sql`
            INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
            VALUES (${id}, ${subject}, ${JSON.stringify(scopes)}, 'dpop-access-token',
              '2026-10-08T19:39:38.320Z', ${expiresAt})
          `;
        yield* insert("legacy-connect", "cloud-connect", preSplit, "2026-10-08T20:39:38.320Z");
        yield* insert(
          "narrowed-connect",
          "cloud-connect",
          narrowedPreSplit,
          "2026-10-08T20:39:38.320Z",
        );
        yield* insert("current-connect", "cloud-connect", standard, "2026-10-08T20:39:38.320Z");
        yield* insert("expired-connect", "cloud-connect", preSplit, "2026-10-08T19:00:00.000Z");
        // A paired client keeps the grant the user chose, even a pre-split one.
        yield* insert("paired", "one-time-token", preSplit, "2026-11-07T19:39:38.320Z");

        yield* TestClock.setTime(Date.parse(now));
        yield* runMigrations({ toMigrationInclusive: 61 });

        const rows = yield* sql<{ readonly sessionId: string; readonly revokedAt: string | null }>`
          SELECT session_id AS "sessionId", revoked_at AS "revokedAt"
          FROM auth_sessions ORDER BY session_id
        `;
        assert.deepStrictEqual(rows, [
          { sessionId: "current-connect", revokedAt: null },
          { sessionId: "expired-connect", revokedAt: null },
          { sessionId: "legacy-connect", revokedAt: now },
          { sessionId: "narrowed-connect", revokedAt: now },
          { sessionId: "paired", revokedAt: null },
        ]);
      }),
    );
  },
);
