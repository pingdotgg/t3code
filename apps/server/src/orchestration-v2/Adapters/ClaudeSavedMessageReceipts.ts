import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { field } from "../unknownField.ts";

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface ReceiptQuery {
  readonly nativeThreadId: string;
  readonly offers: ReadonlyArray<{ readonly id: string }>;
}

function receiptCollector(input: ReceiptQuery) {
  const offers = new Set(input.offers.map((offer) => offer.id));
  const saved = new Set<string>();
  return {
    saved,
    collect: (line: string) => {
      // Most lines are not receipts; skip decoding them, since transcripts reach hundreds of MB.
      if (!line.includes("queued_command") || !line.includes("source_uuid")) return;
      const decoded = decodeLine(line);
      if (Option.isNone(decoded)) return;
      const entry = decoded.value;
      if (
        field(entry, "sessionId") !== input.nativeThreadId ||
        field(entry, "isSidechain") !== false ||
        field(entry, "type") !== "attachment"
      )
        return;
      const attachment = field(entry, "attachment");
      if (field(attachment, "type") !== "queued_command") return;
      const uuid = field(attachment, "source_uuid");
      if (typeof uuid === "string" && offers.has(uuid)) saved.add(uuid);
    },
  };
}

/** Only positive root-history evidence settles an offer; missing or torn history never permits replay. */
export const readClaudeBoundaryReceipts = Effect.fn("readClaudeBoundaryReceipts")(function* (
  input: ReceiptQuery & { readonly projectsDirectory: string },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { saved, collect } = receiptCollector(input);
  const projects = yield* fileSystem
    .readDirectory(input.projectsDirectory)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
  for (const project of projects) {
    const transcript = path.join(input.projectsDirectory, project, `${input.nativeThreadId}.jsonl`);
    if (!(yield* fileSystem.exists(transcript))) continue;
    yield* fileSystem.stream(transcript).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Effect.sync(() => collect(line))),
    );
  }
  return saved;
});

/**
 * Reads the complete lines appended since `offset` and returns where the next read resumes.
 * A receipt is written after its offer is handed off, so a line that straddles the offset is not one.
 */
export const readClaudeBoundaryReceiptTail = Effect.fn("readClaudeBoundaryReceiptTail")(function* (
  input: ReceiptQuery & { readonly transcriptPath: string; readonly offset: number },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const { saved, collect } = receiptCollector(input);
  const info = yield* fileSystem
    .stat(input.transcriptPath)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
  if (info === undefined) return { saved, nextOffset: 0 };
  // A file shorter than the offset was replaced, so nothing in it has been read yet.
  const offset = input.offset <= Number(info.size) ? input.offset : 0;
  // Starting one byte early makes the first newline end either the previous line or a straddling one.
  const start = Math.max(offset - 1, 0);
  const decoder = new TextDecoder();
  let skipFirstLine = start > 0;
  let position = start;
  let nextOffset = offset;
  let carry: Array<Uint8Array> = [];
  yield* fileSystem.stream(input.transcriptPath, { offset: start }).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        let lineStart = 0;
        for (
          let newline = chunk.indexOf(10);
          newline !== -1;
          newline = chunk.indexOf(10, lineStart)
        ) {
          if (skipFirstLine) {
            skipFirstLine = false;
          } else {
            let line = "";
            for (const part of carry) line += decoder.decode(part, { stream: true });
            collect(line + decoder.decode(chunk.subarray(lineStart, newline)));
          }
          carry = [];
          lineStart = newline + 1;
          nextOffset = position + lineStart;
        }
        if (lineStart < chunk.length) carry.push(chunk.slice(lineStart));
        position += chunk.length;
      }),
    ),
  );
  return { saved, nextOffset };
});
