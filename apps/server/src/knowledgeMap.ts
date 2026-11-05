import {
  KnowledgeMapEntries,
  KnowledgeMapError,
  type KnowledgeMapEntry,
  type KnowledgeMapMarkDoneInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "./config.ts";

export class KnowledgeMap extends Context.Service<
  KnowledgeMap,
  {
    readonly list: Effect.Effect<ReadonlyArray<KnowledgeMapEntry>, KnowledgeMapError>;
    readonly markDone: (
      input: KnowledgeMapMarkDoneInput & { readonly threadId: ThreadId },
    ) => Effect.Effect<KnowledgeMapEntry, KnowledgeMapError>;
    readonly remove: (
      topic: string,
    ) => Effect.Effect<ReadonlyArray<KnowledgeMapEntry>, KnowledgeMapError>;
  }
>()("t3/knowledgeMap") {}

const normalize = (topic: string) => topic.trim().replace(/\s+/g, " ").toLowerCase();
const failWith = (message: string) => () => new KnowledgeMapError({ message });

const unavailableEffect = () =>
  Effect.fail(new KnowledgeMapError({ message: "Knowledge map is unavailable." }));
export const unavailable = KnowledgeMap.of({
  list: unavailableEffect(),
  markDone: unavailableEffect,
  remove: unavailableEffect,
});

const decodeEntries = Schema.decodeEffect(Schema.fromJsonString(KnowledgeMapEntries));

export const make = Effect.fn("KnowledgeMap.make")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const filePath = path.join(stateDir, "knowledge.json");

  // A file that exists but doesn't decode fails every call, so nothing ever overwrites it.
  const read = Effect.gen(function* () {
    if (!(yield* fs.exists(filePath))) return [];
    const raw = yield* fs.readFileString(filePath);
    return yield* decodeEntries(raw).pipe(
      Effect.mapError(failWith(`${filePath} is not a valid knowledge map; fix or remove it.`)),
    );
  }).pipe(Effect.catchTags({ PlatformError: (cause) => Effect.fail(failWith(cause.message)()) }));

  const write = (entries: ReadonlyArray<KnowledgeMapEntry>) =>
    fs
      .writeFileString(`${filePath}.tmp`, `${JSON.stringify(entries, null, 2)}\n`)
      .pipe(
        Effect.andThen(fs.rename(`${filePath}.tmp`, filePath)),
        Effect.mapError(failWith("Could not save the knowledge map.")),
      );

  const markDone = Effect.fn("KnowledgeMap.markDone")(function* (
    input: KnowledgeMapMarkDoneInput & { readonly threadId: ThreadId },
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const key = normalize(input.topic);
        const entry: KnowledgeMapEntry = {
          topic: input.topic.trim(),
          explanation: input.explanation,
          buildsOn: input.buildsOn ?? [],
          doneAt: DateTime.formatIso(yield* DateTime.now),
          threadId: input.threadId,
        };
        const others = (yield* read).filter((candidate) => normalize(candidate.topic) !== key);
        yield* write([entry, ...others]);
        return entry;
      }),
    );
  });

  const remove = Effect.fn("KnowledgeMap.remove")(function* (topic: string) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const entries = yield* read;
        const next = entries.filter((entry) => normalize(entry.topic) !== normalize(topic));
        if (next.length !== entries.length) yield* write(next);
        return next;
      }),
    );
  });

  return KnowledgeMap.of({ list: lock.withPermit(read), markDone, remove });
});

export const layer = Layer.effect(
  KnowledgeMap,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* make(config.stateDir);
  }),
);
