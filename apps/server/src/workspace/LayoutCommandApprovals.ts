import { ProjectId, TaskFolderError, type WorktreeLayoutCommandKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * Which of a project's `worktreeLayout` commands a person approved, by the hash of the exact
 * text. This side only reads. Recording an approval is `LayoutCommandApprovalWrites`, which only
 * the client RPC that a person's session calls may import
 * (t3code/no-layout-command-approval-writes).
 */
export class LayoutCommandApprovals extends Context.Service<
  LayoutCommandApprovals,
  {
    readonly isApproved: (input: {
      readonly projectId: ProjectId;
      readonly kind: WorktreeLayoutCommandKind;
      readonly command: string;
    }) => Effect.Effect<boolean, TaskFolderError>;
  }
>()("t3/workspace/LayoutCommandApprovals") {}

export const failed = (cause: unknown) =>
  new TaskFolderError({
    operation: "approve",
    detail: "Could not read the worktree layout command approvals.",
    cause,
  });

/** What an approval is of: the text itself, so one changed character asks again. */
export const commandHash = (digest: Digest.Digest["Service"], command: string) =>
  digest
    .digest(Digest.sha256, new TextEncoder().encode(command))
    .pipe(Effect.map(Hex.encode), Effect.mapError(failed));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;

  const findHash = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, kind: Schema.String }),
    Result: Schema.Struct({ commandHash: Schema.String }),
    execute: ({ projectId, kind }) => sql`
      SELECT command_hash AS "commandHash" FROM layout_command_approvals
      WHERE project_id = ${projectId} AND kind = ${kind}
    `,
  });

  return LayoutCommandApprovals.of({
    isApproved: Effect.fn("LayoutCommandApprovals.isApproved")(function* (input) {
      const approved = yield* findHash(input).pipe(Effect.mapError(failed));
      if (approved._tag === "None") return false;
      return approved.value.commandHash === (yield* commandHash(digest, input.command));
    }),
  });
});

export const layer = Layer.effect(LayoutCommandApprovals, make);
