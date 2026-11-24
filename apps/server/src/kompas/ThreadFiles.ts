import type { KompasError, OrchestrationV2AppThread } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import { kompasError, storageError } from "./KompasDatabase.ts";

const PAGE_CHARS = 40_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 500;

export interface ThreadFilePage {
  readonly text: string;
  /** Where the rest of a long file starts. */
  readonly nextOffset?: number;
}

/**
 * The files a conversation may read: those in its own folder and the ones attached to it. For
 * models whose only way to read a file is a shell, which conversations do not get.
 */
export class ThreadFiles extends Context.Service<
  ThreadFiles,
  {
    readonly read: (input: {
      readonly thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">;
      readonly path: string;
      readonly offset: number;
    }) => Effect.Effect<ThreadFilePage, KompasError>;
  }
>()("t3/kompas/ThreadFiles") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const missing = () =>
    kompasError(
      "not-found",
      "No such file here. You can read this conversation's folder and its attachments.",
    );

  const read: ThreadFiles["Service"]["read"] = Effect.fn("ThreadFiles.read")(function* (input) {
    const folder = input.thread.worktreePath;
    const requested = path.resolve(folder ?? config.attachmentsDir, input.path);
    const realPath = (value: string) => fileSystem.realPath(value).pipe(Effect.mapError(missing));
    const target = yield* realPath(requested);
    const attachments = yield* fileSystem.realPath(config.attachmentsDir).pipe(Effect.option);
    // `<id>.<extension>`, and `.txt` after it for a document's extracted text.
    const attachmentId = path.basename(target).split(".")[0] ?? "";
    const attached =
      Option.contains(attachments, path.dirname(target)) &&
      parseThreadSegmentFromAttachmentId(attachmentId) ===
        toSafeThreadAttachmentSegment(input.thread.id);
    const inFolder = folder !== null && isWithinRoot(path, target, yield* realPath(folder));
    if (!attached && !inFolder) return yield* missing();

    const info = yield* fileSystem.stat(target).pipe(Effect.mapError(storageError));
    if (info.type === "Directory") {
      const names = yield* fileSystem.readDirectory(target).pipe(Effect.mapError(storageError));
      return { text: names.toSorted().slice(0, MAX_ENTRIES).join("\n") };
    }
    if (info.type !== "File") return yield* missing();
    if (Number(info.size) > MAX_FILE_BYTES) {
      return yield* kompasError("limit", "This file is too large to read here.");
    }
    const bytes = yield* fileSystem.readFile(target).pipe(Effect.mapError(storageError));
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => kompasError("invalid", "This is not a text file."),
    });
    const end = input.offset + PAGE_CHARS;
    return {
      text: text.slice(input.offset, end),
      ...(end < text.length ? { nextOffset: end } : {}),
    };
  });

  return ThreadFiles.of({ read });
});

export const layer = Layer.effect(ThreadFiles, make);
