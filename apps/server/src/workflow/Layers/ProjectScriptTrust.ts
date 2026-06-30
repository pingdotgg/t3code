import type { ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  ProjectScriptTrust,
  type ProjectScriptTrustShape,
} from "../Services/ProjectScriptTrust.ts";

const toTrustError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "project script trust failed", cause });

const wrap = <A>(effect: Effect.Effect<A, SqlError>) => effect.pipe(Effect.mapError(toTrustError));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const isTrusted: ProjectScriptTrustShape["isTrusted"] = (projectId: ProjectId) =>
    wrap(sql<{ readonly trusted: number }>`
      SELECT 1 AS trusted
      FROM workflow_project_trust
      WHERE project_id = ${projectId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows.length > 0));

  const setTrusted: ProjectScriptTrustShape["setTrusted"] = (projectId, trusted) => {
    if (!trusted) {
      return wrap(sql`
        DELETE FROM workflow_project_trust
        WHERE project_id = ${projectId}
      `).pipe(Effect.asVoid);
    }

    return Effect.gen(function* () {
      const trustedAt = DateTime.formatIso(yield* DateTime.now);
      yield* wrap(sql`
        INSERT INTO workflow_project_trust (project_id, trusted_at)
        VALUES (${projectId}, ${trustedAt})
        ON CONFLICT(project_id) DO UPDATE SET
          trusted_at = excluded.trusted_at
      `);
    }).pipe(Effect.asVoid);
  };

  return { isTrusted, setTrusted } satisfies ProjectScriptTrustShape;
});

export const ProjectScriptTrustLive = Layer.effect(ProjectScriptTrust, make);
