import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const UnsentCheckout = Schema.Struct({ projectRoot: Schema.String, branch: Schema.String });
const UnsentCheckoutJson = Schema.fromJsonString(UnsentCheckout);
const decodeUnsentCheckout = Schema.decodeUnknownEffect(UnsentCheckoutJson);
const encodeUnsentCheckout = Schema.encodeEffect(UnsentCheckoutJson);

/**
 * A pull request checkout made for a draft, which only clients know about until it is sent.
 * The record sits beside the worktree, not inside it, so it outlives the folder's removal
 * and can restore it. Its modification time is when the checkout was last put to use.
 */
export const makeUnsentCheckouts = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recordPath = (worktreePath: string) =>
    path.join(
      path.dirname(worktreePath),
      `.${path.basename(worktreePath)}.t3-pull-request-checkout`,
    );
  return {
    record: Effect.fn("unsentCheckout.record")(function* (
      worktreePath: string,
      checkout: typeof UnsentCheckout.Type,
    ) {
      yield* fileSystem.writeFileString(
        recordPath(worktreePath),
        yield* encodeUnsentCheckout(checkout),
      );
    }),
    read: Effect.fn("unsentCheckout.read")(
      function* (worktreePath: string) {
        const file = recordPath(worktreePath);
        const checkout = yield* decodeUnsentCheckout(yield* fileSystem.readFileString(file));
        const recordedAt = Option.getOrNull((yield* fileSystem.stat(file)).mtime);
        return recordedAt === null ? null : { ...checkout, recordedAt: recordedAt.getTime() };
      },
      Effect.orElseSucceed(() => null),
    ),
  };
});
