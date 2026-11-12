import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { field } from "../unknownField.ts";

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Only positive root-history evidence settles an offer; missing or torn history never permits replay. */
export const readClaudeBoundaryReceipts = Effect.fn("readClaudeBoundaryReceipts")(
  function* (input: {
    readonly projectsDirectory: string;
    readonly nativeThreadId: string;
    readonly offers: ReadonlyArray<{ readonly id: string }>;
    readonly transcriptPath?: string;
    readonly offset?: number;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const offers = new Map(input.offers.map((offer) => [offer.id, offer]));
    const saved = new Set<string>();
    const transcripts =
      input.transcriptPath === undefined
        ? yield* Effect.gen(function* () {
            const projects = yield* fileSystem
              .readDirectory(input.projectsDirectory)
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
            return projects.map((project) =>
              path.join(input.projectsDirectory, project, `${input.nativeThreadId}.jsonl`),
            );
          })
        : [input.transcriptPath];
    for (const transcript of transcripts) {
      const info = yield* fileSystem
        .stat(transcript)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
      if (info === undefined) continue;
      let offset =
        input.offset !== undefined && input.offset <= Number(info.size) ? input.offset : 0;
      if (offset > 0) {
        const previous = yield* fileSystem
          .stream(transcript, { offset: offset - 1, bytesToRead: 1 })
          .pipe(Stream.runHead);
        if (Option.isNone(previous) || previous.value[0] !== 10) offset = 0;
      }
      yield* fileSystem.stream(transcript, { offset }).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
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
            if (field(attachment, "type") === "queued_command") {
              const uuid = field(attachment, "source_uuid");
              if (typeof uuid === "string" && offers.has(uuid)) saved.add(uuid);
            }
          }),
        ),
      );
    }
    return saved;
  },
);
