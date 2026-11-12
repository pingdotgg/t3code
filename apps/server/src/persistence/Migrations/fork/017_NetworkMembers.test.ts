import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const stamp = (wallMs: number, node: string) => JSON.stringify({ wallMs, counter: 0, node });

layer("fork/017_NetworkMembers", (it) => {
  it.effect("carries device access into the roster without widening anyone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 16 });
      // The owner once lowered the shared default; nobody set the box's own level.
      yield* sql`
        INSERT INTO tailnet_device_settings (id, settings_json) VALUES (1, ${JSON.stringify({
          autoLink: true,
          defaultAccess: "auto",
          requireCapability: false,
          updatedAt: null,
          updatedBy: null,
        })})
      `;
      yield* sql`
        INSERT INTO tailnet_device_policy (environment_id, access, stamp_json, updated_by) VALUES
          ('env-studio', 'read-only', ${stamp(50, "env-laptop")}, 'env-laptop'),
          ('env-old', 'revoked', ${stamp(40, "env-studio")}, 'env-studio')
      `;
      const link = (id: string, label: string, origin: string, access: string) => sql`
        INSERT INTO peer_environment_links
          (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, origin)
        VALUES (${id}, ${`peer-${id}`}, ${label}, '[]', ${access},
          '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', ${origin})
      `;
      yield* link("env-studio", "Studio", "tailnet", "full-access");
      yield* link("env-box", "Box", "tailnet", "full-access");
      yield* link("env-paired", "Paired", "paired", "full-access");
      // The grant each holds here by pairing code: the box was let in read-only, the studio
      // supervised; an expired grant and a full one change nothing.
      const session = (
        id: string,
        peer: string,
        scopes: ReadonlyArray<string>,
        expiresAt: string,
      ) =>
        sql`
          INSERT INTO auth_sessions
            (session_id, subject, scopes, method, issued_at, expires_at, peer_environment_id)
          VALUES (${id}, 'mcp-client', ${JSON.stringify(scopes)}, 'bearer-access-token',
            '2026-11-01T00:00:00.000Z', ${expiresAt}, ${peer})
        `;
      yield* session("s-box", "env-box", ["orchestration:read"], "2999-01-01T00:00:00.000Z");
      yield* session(
        "s-studio",
        "env-studio",
        ["orchestration:read", "orchestration:operate"],
        "2999-01-01T00:00:00.000Z",
      );
      yield* session(
        "s-studio-full",
        "env-studio",
        ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"],
        "2000-01-01T00:00:00.000Z",
      );
      yield* session(
        "s-old",
        "env-old",
        ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"],
        "2999-01-01T00:00:00.000Z",
      );
      // Found on the tailnet, never linked: not a member.
      yield* sql`
        INSERT INTO tailnet_devices (environment_id, label, urls_json, tailnet_name, last_seen_at)
        VALUES ('env-found', 'Found', '[]', 'found', NULL)
      `;

      yield* runMigrations();

      const members = yield* sql<{
        readonly environment_id: string;
        readonly label: string;
        readonly node_id: string | null;
        readonly access: string;
        readonly stamp_json: string;
      }>`SELECT * FROM network_members ORDER BY environment_id`;
      assert.deepEqual(
        members.map((row) => [
          row.environment_id,
          row.label,
          row.node_id,
          row.access,
          JSON.parse(row.stamp_json).wallMs,
        ]),
        [
          ["env-box", "Box", null, "auto", 0],
          ["env-old", "env-old", null, "revoked", 40],
          ["env-studio", "Studio", null, "read-only", 50],
        ],
      );
      // The node is unproven, so it stays unbound until the user adds the machine again.
      assert.deepEqual(
        yield* sql`SELECT environment_id, access FROM network_member_limits ORDER BY environment_id`,
        [
          { environment_id: "env-box", access: "read-only" },
          { environment_id: "env-studio", access: "approval-required" },
        ],
      );
    }),
  );
});
