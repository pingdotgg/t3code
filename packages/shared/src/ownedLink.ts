import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";

/**
 * Replaces `link` with a symlink to `target`, or removes it without a `target`, when `owns` holds
 * for what is there. Another program can write `link` after any earlier check, so the entry is
 * moved aside and checked there. Returns false when it was not ours; it is then put back without
 * overwriting anything newer, or left beside `link` as `.<name>.<pid>.<n>.old` if that fails.
 */
export const replaceOwnedLink = Effect.fn("ownedLink.replace")(function* <E, R>(input: {
  readonly link: string;
  readonly target?: string;
  readonly owns: (path: string) => Effect.Effect<boolean, E, R>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A sibling, so a relative link resolves the same there, reserved so nothing left by an
  // earlier run is replaced. A directory cannot be renamed over it, so one fails here.
  const aside = path.join(
    path.dirname(input.link),
    `.${path.basename(input.link)}.${process.pid}.${yield* Random.nextIntBetween(0, 0x7fffffff)}.old`,
  );
  yield* fs.writeFileString(aside, "", { flag: "wx" });
  const discard = fs.remove(aside);
  yield* fs.rename(input.link, aside).pipe(Effect.tapError(() => discard.pipe(Effect.ignore)));
  if (!(yield* input.owns(aside))) {
    const text = yield* fs.readLink(aside).pipe(Effect.option);
    yield* (
      Option.isSome(text) ? fs.symlink(text.value, input.link) : fs.link(aside, input.link)
    ).pipe(Effect.andThen(discard));
    return false;
  }
  // Something written after the move keeps the name; this home's old link goes either way.
  yield* (input.target === undefined ? Effect.void : fs.symlink(input.target, input.link)).pipe(
    Effect.ensuring(discard.pipe(Effect.ignore)),
  );
  return true;
});
