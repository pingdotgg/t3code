// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's readLink and symlink take strings, not the raw bytes a link may hold.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

/**
 * The text of the link at `file`, only when it reads back as the same bytes. Text that is not
 * UTF-8 decodes to another name than the one the OS follows, so it never counts as anyone's.
 */
export const readLinkText = Effect.fn("ownedLink.read_link_text")(function* (file: string) {
  const raw = yield* Effect.tryPromise(() => NodeFSP.readlink(file, { encoding: "buffer" })).pipe(
    Effect.option,
  );
  if (Option.isNone(raw)) return Option.none<string>();
  const text = raw.value.toString("utf8");
  return Buffer.from(text).equals(raw.value) ? Option.some(text) : Option.none<string>();
});

/** An entry moved aside could not go back; it is still at `path`. */
export class OwnedLinkError extends Schema.TaggedError<OwnedLinkError>()("OwnedLinkError", {
  path: Schema.String,
}) {
  override get message(): string {
    return `Could not put back the entry now at ${this.path}.`;
  }
}

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
  // Not interrupted between moving the entry aside and putting a link back, so a cancelled
  // install never leaves the name empty. A closed terminal's SIGHUP would end Node at once.
  const ignoreHangup = () => {};
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => process.on("SIGHUP", ignoreHangup)),
    () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* fs
            .rename(input.link, aside)
            .pipe(Effect.tapError(() => discard.pipe(Effect.ignore)));
          // Exclusive, so it never overwrites anything written at `link` meanwhile. The link text is
          // copied as bytes; a string would mangle a target that is not UTF-8.
          const putBack = Effect.tryPromise({
            try: () => NodeFSP.readlink(aside, { encoding: "buffer" }),
            catch: () => new OwnedLinkError({ path: aside }),
          }).pipe(
            Effect.option,
            Effect.flatMap((text) =>
              Option.isSome(text)
                ? Effect.tryPromise({
                    try: () => NodeFSP.symlink(text.value, input.link),
                    catch: () => new OwnedLinkError({ path: aside }),
                  })
                : fs
                    .link(aside, input.link)
                    .pipe(Effect.mapError(() => new OwnedLinkError({ path: aside }))),
            ),
          );
          if (!(yield* input.owns(aside))) {
            yield* putBack.pipe(Effect.andThen(discard));
            return false;
          }
          if (input.target !== undefined) {
            // On failure the old link goes back while the name is free, so the command keeps working;
            // if it cannot, it stays beside `link`.
            yield* fs.symlink(input.target, input.link).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  // Another install made the same link a moment ago: that is done, not failed.
                  const now = yield* readLinkText(input.link);
                  if (Option.getOrUndefined(now) === input.target) return;
                  yield* putBack.pipe(Effect.andThen(discard.pipe(Effect.ignore)));
                  return yield* error;
                }),
              ),
            );
          }
          yield* discard.pipe(Effect.ignore);
          return true;
        }),
      ),
    () => Effect.sync(() => process.off("SIGHUP", ignoreHangup)),
  );
});
