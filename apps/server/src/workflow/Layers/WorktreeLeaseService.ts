import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  WorktreeLeaseService,
  type Lease,
  type WorktreeLeaseServiceShape,
} from "../Services/WorktreeLeaseService.ts";

// NOTE: expires_at is written on acquire/release purely to satisfy the
// NOT NULL column (migration 033) and to leave an audit timestamp. It is NOT
// enforced: acquire is unconditional (ON CONFLICT always takes ownership and
// bumps the fence token) and isValid checks only fence_token + owner_kind, so
// no code path reaps or blocks on an expired lease. The lease provides
// fence-token release gating, not expiry-based mutual exclusion — do not treat
// a non-expired lease as a held lock. Enforcing expiry (or dropping the column)
// requires a deliberate behavior/migration change, not a silent one.
const leaseExpiresAt = (now: DateTime.Utc) => DateTime.add(now, { minutes: 30 });

const toLeaseError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "lease op failed", cause });

const wrap = <A>(effect: Effect.Effect<A, SqlError>) => effect.pipe(Effect.mapError(toLeaseError));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const acquire: WorktreeLeaseServiceShape["acquire"] = (worktreeRef, ownerKind, ownerId) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const acquiredAt = DateTime.formatIso(now);
      const expiresAt = DateTime.formatIso(leaseExpiresAt(now));
      const rows = yield* wrap(sql<Lease>`
        INSERT INTO worktree_lease (
          worktree_ref,
          owner_kind,
          owner_id,
          fence_token,
          acquired_at,
          expires_at
        )
        VALUES (
          ${worktreeRef},
          ${ownerKind},
          ${ownerId},
          COALESCE(
            (SELECT fence_token FROM worktree_lease WHERE worktree_ref = ${worktreeRef}),
            0
          ) + 1,
          ${acquiredAt},
          ${expiresAt}
        )
        ON CONFLICT(worktree_ref) DO UPDATE SET
          owner_kind = excluded.owner_kind,
          owner_id = excluded.owner_id,
          fence_token = worktree_lease.fence_token + 1,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        RETURNING fence_token AS "fenceToken"
      `);
      const lease = rows[0];
      if (!lease) {
        return yield* new WorkflowEventStoreError({ message: "lease acquire returned no row" });
      }
      return lease;
    });

  const release: WorktreeLeaseServiceShape["release"] = (worktreeRef, fenceToken) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* wrap(sql`
        UPDATE worktree_lease
        SET owner_kind = 'released',
            owner_id = '',
            fence_token = fence_token + 1,
            acquired_at = ${now},
            expires_at = ${now}
        WHERE worktree_ref = ${worktreeRef}
          AND fence_token = ${fenceToken}
      `);
    }).pipe(Effect.asVoid);

  const isValid: WorktreeLeaseServiceShape["isValid"] = (worktreeRef, fenceToken) =>
    wrap(sql<{ readonly fenceToken: number; readonly ownerKind: string }>`
      SELECT
        fence_token AS "fenceToken",
        owner_kind AS "ownerKind"
      FROM worktree_lease
      WHERE worktree_ref = ${worktreeRef}
    `).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row?.fenceToken === fenceToken && row.ownerKind !== "released";
      }),
    );

  return { acquire, release, isValid } satisfies WorktreeLeaseServiceShape;
});

export const WorktreeLeaseServiceLive = Layer.effect(WorktreeLeaseService, make);
