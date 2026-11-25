import type { ProjectId, TaskFolderError, WorktreeLayoutCommandKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { commandHash, failed } from "./LayoutCommandApprovals.ts";

/**
 * Records and withdraws approvals of a project's `worktreeLayout` commands. An approval lets the
 * server run that text, so only a person may give one: nothing an agent can call imports this.
 */
export class LayoutCommandApprovalWrites extends Context.Service<
  LayoutCommandApprovalWrites,
  {
    /** `command` is the text the person was shown; null withdraws the approval. */
    readonly set: (input: {
      readonly projectId: ProjectId;
      readonly kind: WorktreeLayoutCommandKind;
      readonly command: string | null;
    }) => Effect.Effect<void, TaskFolderError>;
  }
>()("t3/workspace/LayoutCommandApprovalWrites") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;

  return LayoutCommandApprovalWrites.of({
    set: Effect.fn("LayoutCommandApprovalWrites.set")(function* ({ projectId, kind, command }) {
      if (command === null) {
        yield* sql`
          DELETE FROM layout_command_approvals WHERE project_id = ${projectId} AND kind = ${kind}
        `.pipe(Effect.mapError(failed));
        return;
      }
      const hash = yield* commandHash(digest, command);
      const approvedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO layout_command_approvals (project_id, kind, command_hash, approved_at)
        VALUES (${projectId}, ${kind}, ${hash}, ${approvedAt})
        ON CONFLICT (project_id, kind) DO UPDATE SET
          command_hash = excluded.command_hash,
          approved_at = excluded.approved_at
      `.pipe(Effect.mapError(failed));
    }),
  });
});

export const layer = Layer.effect(LayoutCommandApprovalWrites, make);
