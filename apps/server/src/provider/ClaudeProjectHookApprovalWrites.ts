import type { ClaudeProjectHooksError, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { failed } from "./ClaudeProjectHooks.ts";

/**
 * Records and withdraws approvals of the hooks in a project's Claude Code settings. An approval
 * lets every Claude session of the project run them, so only a person may give one: nothing an
 * agent can call imports this.
 */
export class ClaudeProjectHookApprovalWrites extends Context.Service<
  ClaudeProjectHookApprovalWrites,
  {
    /** `hooksHash` names the hooks the person was shown; null withdraws every approval of the project. */
    readonly set: (input: {
      readonly projectId: ProjectId;
      readonly hooksHash: string | null;
    }) => Effect.Effect<void, ClaudeProjectHooksError>;
  }
>()("t3/provider/ClaudeProjectHookApprovalWrites") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return ClaudeProjectHookApprovalWrites.of({
    set: Effect.fn("ClaudeProjectHookApprovalWrites.set")(
      function* ({ projectId, hooksHash }) {
        if (hooksHash === null) {
          yield* sql`DELETE FROM claude_project_hook_approvals WHERE project_id = ${projectId}`;
          return;
        }
        const approvedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO claude_project_hook_approvals (project_id, hooks_hash, approved_at)
          VALUES (${projectId}, ${hooksHash}, ${approvedAt})
          ON CONFLICT (project_id, hooks_hash) DO UPDATE SET approved_at = excluded.approved_at
        `;
      },
      Effect.mapError(failed("Could not record the approval of the project's hooks.")),
    ),
  });
});

export const layer = Layer.effect(ClaudeProjectHookApprovalWrites, make);
