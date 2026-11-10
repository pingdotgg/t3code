/**
 * Shared config for the release scripts, read from env vars set by the
 * release workflow.
 *
 * ALCHEMY_REPO   `<owner>/<repo>` for changelog/release-note URLs
 */
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class InvalidRepo extends Data.TaggedError("InvalidRepo")<{
  readonly message: string;
}> {}

/** `ALCHEMY_REPO`, as `<owner>/<repo>`. */
export const repository = Effect.gen(function* () {
  const repo = (yield* Config.String("ALCHEMY_REPO")).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return yield* new InvalidRepo({
      message: `ALCHEMY_REPO must be <owner>/<repo> (got: ${repo})`,
    });
  }
  return repo;
});
