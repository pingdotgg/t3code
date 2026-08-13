/**
 * Per-workspace cache for driver skill discovery. Codex answers by spawning a
 * `codex app-server`, so reopening the picker must not re-probe.
 *
 * @module provider/workspaceSkills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

const WORKSPACE_SKILLS_TTL = Duration.seconds(30);
const WORKSPACE_SKILLS_CAPACITY = 32;

/**
 * Wrap a driver's workspace skill discovery in the shared cache policy. Only
 * answers are cached; an `undefined` is evicted again immediately so one
 * unlucky probe does not blank the picker for the rest of the TTL.
 */
export const makeWorkspaceSkillsCache = Effect.fn("makeWorkspaceSkillsCache")(function* (
  discover: (cwd: string) => Effect.Effect<ReadonlyArray<ServerProviderSkill> | undefined>,
) {
  const cache = yield* Cache.make({
    capacity: WORKSPACE_SKILLS_CAPACITY,
    timeToLive: WORKSPACE_SKILLS_TTL,
    lookup: discover,
  });

  return (cwd: string) =>
    Effect.gen(function* () {
      const skills = yield* Cache.get(cache, cwd);
      if (skills === undefined) {
        // `invalidateWhen` re-reads the stored value, so a concurrent lookup
        // that already succeeded is never thrown away.
        yield* Cache.invalidateWhen(cache, cwd, (cached) => cached === undefined);
      }
      return skills;
    });
});
