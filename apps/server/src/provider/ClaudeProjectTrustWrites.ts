import {
  ClaudeProjectTrustError,
  managedPolicyDeniedMessage,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { failed } from "./ClaudeProjectTrust.ts";

/**
 * Records and withdraws a person's trust in a project's Claude Code settings. Trust lets every
 * Claude session of the project run the commands its folder names, so only a person may give it:
 * nothing an agent can call imports this.
 */
export class ClaudeProjectTrustWrites extends Context.Service<
  ClaudeProjectTrustWrites,
  {
    readonly set: (input: {
      readonly projectId: ProjectId;
      readonly trusted: boolean;
    }) => Effect.Effect<void, ClaudeProjectTrustError>;
  }
>()("t3/provider/ClaudeProjectTrustWrites") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const offBy = ManagedPolicy.deniedBy(yield* ManagedPolicy.ManagedPolicy, "claudeProjectHooks");
  const unrecorded = failed("Could not record whether the project is trusted.");

  return ClaudeProjectTrustWrites.of({
    set: Effect.fn("ClaudeProjectTrustWrites.set")(function* ({ projectId, trusted }) {
      if (!trusted) {
        return yield* sql`DELETE FROM claude_trusted_projects WHERE project_id = ${projectId}`.pipe(
          Effect.asVoid,
          Effect.mapError(unrecorded),
        );
      }
      if (offBy !== undefined) {
        return yield* new ClaudeProjectTrustError({
          detail: managedPolicyDeniedMessage(offBy, "trusting a project's Claude Code settings"),
        });
      }
      const trustedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO claude_trusted_projects (project_id, trusted_at)
        VALUES (${projectId}, ${trustedAt})
        ON CONFLICT (project_id) DO NOTHING
      `.pipe(Effect.mapError(unrecorded));
    }),
  });
});

export const layer = Layer.effect(ClaudeProjectTrustWrites, make);
