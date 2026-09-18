/** Application policy, shared by push, REST ref writes, and pull merges. */
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import { Session, Unauthorized } from "./auth.ts";

export const checkRefChanges = (
  repo: Git.RepoMetaData,
  updates: ReadonlyArray<Git.RefUpdate>,
) =>
  Effect.gen(function* () {
    const { user } = yield* Session;
    if (user === null) return yield* new Unauthorized();
    for (const update of updates) {
      if (user.id.toLowerCase() !== repo.owner.toLowerCase()) {
        return yield* new Git.PushDenied({
          ref: update.ref,
          reason: "only the repository owner may change refs",
        });
      }
      if (
        update.ref === `refs/heads/${repo.defaultBranch}` &&
        /^0+$/.test(update.newOid)
      ) {
        return yield* new Git.PushDenied({
          ref: update.ref,
          reason: "the default branch cannot be deleted",
        });
      }
    }
  });
