import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  KnowledgeMapEntries,
  KnowledgeMapError,
  type KnowledgeMapEntry,
  type KnowledgeMapMarkDoneInput,
} from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";

export class KnowledgeMap extends Context.Service<
  KnowledgeMap,
  {
    readonly list: Effect.Effect<ReadonlyArray<KnowledgeMapEntry>, KnowledgeMapError>;
    readonly markDone: (
      input: KnowledgeMapMarkDoneInput & { readonly threadId: KnowledgeMapEntry["threadId"] },
    ) => Effect.Effect<KnowledgeMapEntry, KnowledgeMapError>;
    readonly remove: (
      topic: string,
    ) => Effect.Effect<ReadonlyArray<KnowledgeMapEntry>, KnowledgeMapError>;
  }
>()("t3/knowledgeMap") {}

const normalize = (topic: string) => topic.trim().replace(/\s+/g, " ").toLowerCase();
const error = (message: string) => new KnowledgeMapError({ message });
const unavailableEffect = () => Effect.fail(error("Knowledge map is unavailable."));
export const unavailable = KnowledgeMap.of({
  list: unavailableEffect(),
  markDone: Effect.fn("KnowledgeMap.markDone")(unavailableEffect),
  remove: Effect.fn("KnowledgeMap.remove")(unavailableEffect),
});
const isKnowledgeMapError = Schema.is(KnowledgeMapError);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEntries = Schema.decodeUnknownEffect(KnowledgeMapEntries);

export const layer = Layer.effect(
  KnowledgeMap,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const filePath = path.join(config.stateDir, "knowledge.json");

    const read = Effect.gen(function* () {
      if (!(yield* fs.exists(filePath))) return [] as ReadonlyArray<KnowledgeMapEntry>;
      const raw = yield* fs
        .readFileString(filePath)
        .pipe(Effect.mapError(() => error("Could not read knowledge map.")));
      const parsed = yield* decodeJson(raw).pipe(
        Effect.mapError(() => error("Knowledge map is not valid JSON.")),
      );
      return yield* decodeEntries(parsed).pipe(
        Effect.mapError(() => error("Knowledge map has an invalid shape.")),
      );
    });
    const write = (entries: ReadonlyArray<KnowledgeMapEntry>) =>
      fs.writeFileString(`${filePath}.tmp`, JSON.stringify(entries, null, 2) + "\n").pipe(
        Effect.mapError(() => error("Could not write knowledge map.")),
        Effect.andThen(
          fs
            .rename(`${filePath}.tmp`, filePath)
            .pipe(Effect.mapError(() => error("Could not replace knowledge map."))),
        ),
      );
    const list = lock
      .withPermit(read)
      .pipe(
        Effect.mapError((cause) =>
          isKnowledgeMapError(cause) ? cause : error("Could not read knowledge map."),
        ),
      );
    const markDone = (
      input: KnowledgeMapMarkDoneInput & { readonly threadId: KnowledgeMapEntry["threadId"] },
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          const entries = [...(yield* read)];
          const key = normalize(input.topic);
          const entry: KnowledgeMapEntry = {
            topic: input.topic.trim(),
            explanation: input.explanation,
            buildsOn: input.buildsOn ?? [],
            doneAt: DateTime.formatIso(yield* DateTime.now),
            threadId: input.threadId,
          };
          const next = [
            entry,
            ...entries.filter((candidate) => normalize(candidate.topic) !== key),
          ];
          yield* write(next);
          return entry;
        }),
      );
    const remove = (topic: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const entries = [...(yield* read)];
          const next = entries.filter((entry) => normalize(entry.topic) !== normalize(topic));
          if (next.length !== entries.length) yield* write(next);
          return next;
        }),
      );
    const markDonePublic = Effect.fn("KnowledgeMap.markDone")(
      (input: KnowledgeMapMarkDoneInput & { readonly threadId: KnowledgeMapEntry["threadId"] }) =>
        markDone(input).pipe(
          Effect.mapError((cause) =>
            isKnowledgeMapError(cause) ? cause : error("Could not update knowledge map."),
          ),
        ),
    );
    const removePublic = Effect.fn("KnowledgeMap.remove")((topic: string) =>
      remove(topic).pipe(
        Effect.mapError((cause) =>
          isKnowledgeMapError(cause) ? cause : error("Could not update knowledge map."),
        ),
      ),
    );
    return KnowledgeMap.of({ list, markDone: markDonePublic, remove: removePublic });
  }),
);
