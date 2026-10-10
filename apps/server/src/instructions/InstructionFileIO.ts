/**
 * InstructionFileIO - the file reads and writes under instruction files.
 *
 * An instruction file is often a link: an agent's home file linked to the Global `AGENTS.md`, or
 * the Global file itself behind a dotfiles checkout. So a read follows links, and a write goes to
 * the file's real path (`writeTargetOf`), where `writeFileStringAtomically` replaces it with a
 * temp file and a rename. Renaming over the link instead would swap the link for a copy and leave
 * the Global file stale.
 *
 * @module InstructionFileIO
 */
// @effect-diagnostics nodeBuiltinImport:off - Revisions are sha256 hashes of a file's bytes.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readLinkTarget } from "../skills/SkillLinks.ts";

/** The largest instruction file T3 Code reads or writes, in bytes. */
export const INSTRUCTION_MAX_BYTES = 1_048_576;

const MAX_LINK_HOPS = 32;

/** What is at a path, looking at the path itself and at where it leads. */
export interface FileFacts {
  readonly path: string;
  /** Something is at the path. A link that leads nowhere counts. */
  readonly present: boolean;
  /** Absolute path a link points at; undefined when the path is not a link. */
  readonly linkTarget: string | undefined;
  /** The path leads to a regular file. */
  readonly isFile: boolean;
  /** Bytes; 0 unless the path leads to a regular file. */
  readonly size: number;
  /** Where the path really is, when it leads somewhere that exists. */
  readonly real: string | undefined;
}

export const inspect = Effect.fn("InstructionFileIO.inspect")(function* (target: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const link = yield* readLinkTarget(target).pipe(
    Effect.orElseSucceed(() => ({ _tag: "Missing" }) as const),
  );
  const info = yield* fileSystem.stat(target).pipe(Effect.option);
  const real = info._tag === "Some" ? yield* realPathOf(target) : undefined;
  const isFile = info._tag === "Some" && info.value.type === "File";
  return {
    path: target,
    present: link._tag !== "Missing" || info._tag === "Some",
    linkTarget: link._tag === "Link" ? path.resolve(path.dirname(target), link.target) : undefined,
    isFile,
    size: isFile && info._tag === "Some" ? Number(info.value.size) : 0,
    real,
  } satisfies FileFacts;
});

const realPathOf = (target: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.realPath(target)),
    Effect.orElseSucceed(() => undefined),
  );

export const sha256 = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export type ReadOutcome =
  /** Nothing is there. */
  | { readonly _tag: "Missing" }
  /** Something is there that isn't a regular file, couldn't be read, or isn't UTF-8 text. */
  | { readonly _tag: "Unreadable" }
  | { readonly _tag: "TooLarge" }
  | { readonly _tag: "Read"; readonly text: string; readonly revision: string };

// A file's byte order mark stays in its text, as the character it is. Decoding without it would
// drop the mark when the text is saved or an import line is added, and the BOM handling in
// `ClaudeInstructionSetting` would never run.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of the file at a path, following links, bounded to `INSTRUCTION_MAX_BYTES`. */
export const readText = Effect.fn("InstructionFileIO.readText")(function* (target: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(target).pipe(Effect.option);
  if (info._tag === "None") {
    const present = yield* readLinkTarget(target).pipe(
      Effect.map((state) => state._tag !== "Missing"),
      Effect.orElseSucceed(() => false),
    );
    return (present ? { _tag: "Unreadable" } : { _tag: "Missing" }) as ReadOutcome;
  }
  if (info.value.type !== "File") return { _tag: "Unreadable" } as ReadOutcome;
  if (Number(info.value.size) > INSTRUCTION_MAX_BYTES) return { _tag: "TooLarge" } as ReadOutcome;
  const bytes = yield* fileSystem.readFile(target).pipe(Effect.option);
  if (bytes._tag === "None") return { _tag: "Unreadable" } as ReadOutcome;
  if (bytes.value.byteLength > INSTRUCTION_MAX_BYTES) return { _tag: "TooLarge" } as ReadOutcome;
  try {
    return {
      _tag: "Read",
      text: decoder.decode(bytes.value),
      revision: sha256(bytes.value),
    } as ReadOutcome;
  } catch {
    return { _tag: "Unreadable" } as ReadOutcome;
  }
});

/**
 * The path a write to `target` must go to: the real file behind any links, or where a link that
 * leads nowhere would land, or `target` itself when it is not a link and doesn't exist yet.
 */
export const writeTargetOf = Effect.fn("InstructionFileIO.writeTargetOf")(function* (
  target: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const real = yield* fileSystem.realPath(target).pipe(Effect.option);
  if (real._tag === "Some") return real.value;
  let current = target;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const state = yield* readLinkTarget(current).pipe(
      Effect.orElseSucceed(() => ({ _tag: "Missing" }) as const),
    );
    if (state._tag !== "Link") break;
    current = path.resolve(path.dirname(current), state.target);
  }
  // A new file lands in its folder as that folder really is.
  const folder = yield* realPathOf(path.dirname(current));
  return folder === undefined ? current : path.join(folder, path.basename(current));
});
