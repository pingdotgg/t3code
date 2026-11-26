import {
  ClaudeProjectHooksError,
  type ProjectId,
  type WorkspaceClaudeProjectHooksResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ClaudeProjectHooks, failed } from "./ClaudeProjectHooks.ts";

/**
 * Records and withdraws approvals of the hooks and helper commands in a project's Claude Code
 * settings. An approval lets every Claude session of the project run them, so only a person may
 * give one: nothing an agent can call imports this.
 */
export class ClaudeProjectHookApprovalWrites extends Context.Service<
  ClaudeProjectHookApprovalWrites,
  {
    /**
     * Approves what the folder `cwd` declares now, when `hooksHash` names it: an approval is for
     * what the person was shown and nothing newer. Null withdraws every approval of the project.
     * Answers with the folder as it stands afterwards.
     */
    readonly set: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string;
      readonly hooksHash: string | null;
    }) => Effect.Effect<WorkspaceClaudeProjectHooksResult, ClaudeProjectHooksError>;
  }
>()("t3/provider/ClaudeProjectHookApprovalWrites") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hooks = yield* ClaudeProjectHooks;
  const unrecorded = failed("Could not record the approval of the project's hooks.");

  return ClaudeProjectHookApprovalWrites.of({
    set: Effect.fn("ClaudeProjectHookApprovalWrites.set")(function* ({
      projectId,
      cwd,
      hooksHash,
    }) {
      if (hooksHash === null) {
        yield* sql`DELETE FROM claude_project_hook_approvals WHERE project_id = ${projectId}`.pipe(
          Effect.mapError(unrecorded),
        );
        return yield* hooks.read({ projectId, cwd });
      }
      const shown = yield* hooks.read({ projectId, cwd });
      if (shown.hooksHash !== hooksHash) {
        return yield* new ClaudeProjectHooksError({
          detail: "The project's hooks changed since they were shown. Review them again.",
        });
      }
      const approvedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO claude_project_hook_approvals (project_id, hooks_hash, approved_at)
        VALUES (${projectId}, ${hooksHash}, ${approvedAt})
        ON CONFLICT (project_id, hooks_hash) DO UPDATE SET approved_at = excluded.approved_at
      `.pipe(Effect.mapError(unrecorded));
      return yield* hooks.read({ projectId, cwd });
    }),
  });
});

export const layer = Layer.effect(ClaudeProjectHookApprovalWrites, make);
