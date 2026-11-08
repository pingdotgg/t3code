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
    readonly offers: ReadonlyArray<{ readonly id: string; readonly legacyContext?: string }>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const offers = new Map(input.offers.map((offer) => [offer.id, offer]));
    const saved = new Set<string>();
    const projects = yield* fileSystem
      .readDirectory(input.projectsDirectory)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    for (const project of projects) {
      const transcript = path.join(
        input.projectsDirectory,
        project,
        `${input.nativeThreadId}.jsonl`,
      );
      if (!(yield* fileSystem.exists(transcript))) continue;
      yield* fileSystem.stream(transcript).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
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
            } else if (field(attachment, "type") === "hook_additional_context") {
              const content = field(attachment, "content");
              if (!Array.isArray(content)) return;
              const contexts = content.flatMap((context) => {
                if (typeof context !== "string") return [];
                const prefix = "New messages:\n";
                // Legacy hooks saved the complete batch as one wrapped context string.
                return context.startsWith(prefix)
                  ? context
                      .slice(prefix.length)
                      .split(/\n\n(?=From (?:the user|another agent) \(delivery [^\n)]+\):\n)/)
                  : [context];
              });
              for (const offer of offers.values()) {
                if (offer.legacyContext !== undefined && contexts.includes(offer.legacyContext)) {
                  saved.add(offer.id);
                }
              }
            }
          }),
        ),
      );
    }
    return saved;
  },
);
