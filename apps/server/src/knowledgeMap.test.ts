import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as KnowledgeMap from "./knowledgeMap.ts";

const threadId = ThreadId.make("thread-1");

const withMap = <A, E>(
  body: (
    map: KnowledgeMap.KnowledgeMap["Service"],
    file: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
  existing?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = (yield* Path.Path).join(dir, "knowledge.json");
    if (existing !== undefined) yield* fs.writeFileString(file, existing);
    return yield* body(yield* KnowledgeMap.make(dir), file);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("KnowledgeMap", () => {
  it.effect("marking a topic again replaces it, whatever its case and spacing", () =>
    withMap((map) =>
      Effect.gen(function* () {
        yield* map.markDone({ topic: "Set  theory", explanation: "first", threadId });
        yield* map.markDone({ topic: "set theory", explanation: "second", threadId });
        const entries = yield* map.list;
        assert.deepStrictEqual(
          entries.map((entry) => entry.explanation),
          ["second"],
        );
      }),
    ),
  );

  it.effect("remove deletes a topic and ignores one that isn't there", () =>
    withMap((map) =>
      Effect.gen(function* () {
        yield* map.markDone({ topic: "Combinatorics", explanation: "words", threadId });
        assert.lengthOf(yield* map.remove("combinatorics"), 0);
        assert.lengthOf(yield* map.remove("missing"), 0);
      }),
    ),
  );

  it.effect("a corrupt file fails the save and keeps its bytes", () =>
    withMap(
      (map, file) =>
        Effect.gen(function* () {
          const failure = yield* map
            .markDone({ topic: "Combinatorics", explanation: "words", threadId })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "KnowledgeMapError");
          assert.strictEqual(
            yield* (yield* FileSystem.FileSystem).readFileString(file),
            "not json",
          );
        }),
      "not json",
    ),
  );
});
