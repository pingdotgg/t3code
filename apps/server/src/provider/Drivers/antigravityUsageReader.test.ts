// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's File.Info has no ctime or sub-millisecond mtime, which the cache tests compare.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as AntigravityUsage from "./AntigravityUsage.ts";
import {
  ANTIGRAVITY_USAGE_CACHE_FILE_NAME,
  decodeAntigravityUsageCache,
  encodeAntigravityUsageCache,
  makeAntigravityUsageCache,
  readAntigravityUsage,
} from "./antigravityUsageReader.ts";

const openDatabase = Effect.fn("openDatabase")(function* (filename: string) {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
  const sql = Context.get(context, SqlClient.SqlClient);
  return {
    exec: (statement: string) => sql.unsafe(statement),
    run: (statement: string, params: ReadonlyArray<unknown>) => sql.unsafe(statement, params),
  };
});

const seedDatabase = <E>(
  filename: string,
  seed: (db: Effect.Success<ReturnType<typeof openDatabase>>) => Effect.Effect<void, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed(yield* openDatabase(filename));
    }),
  );

const tempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
});

function protoNumber(field: number, value: number): number[] {
  const varint = (number: number) => {
    const bytes: number[] = [];
    do {
      const byte = number % 128;
      number = Math.floor(number / 128);
      bytes.push(byte + (number > 0 ? 128 : 0));
    } while (number > 0);
    return bytes;
  };
  return [...varint(field * 8), ...varint(value)];
}

function protoBytes(field: number, bytes: readonly number[]): number[] {
  const encoded = protoNumber(field, bytes.length);
  encoded[0] = encoded[0]! + 2;
  return [...encoded, ...bytes];
}

function protoText(field: number, value: string): number[] {
  return protoBytes(field, [...Buffer.from(value)]);
}

const TABLES =
  "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)";

const createTables = (db: Effect.Success<ReturnType<typeof openDatabase>>) =>
  Effect.forEach(TABLES.split("; "), db.exec, { discard: true });

const records = (result: Effect.Success<ReturnType<typeof readAntigravityUsage>>) =>
  result.files.flatMap((file) => file.records);

describe("readAntigravityUsage", () => {
  it.effect(
    "deduplicates Antigravity generation and step usage while preserving retry model and token buckets",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        const stamp = protoNumber(1, 1780000000);
        const usage = [
          ...protoNumber(2, 100),
          ...protoNumber(3, 40),
          ...protoNumber(4, 5),
          ...protoNumber(5, 20),
          ...protoNumber(9, 10),
          ...protoText(11, "response-1"),
        ];
        const retry = [
          ...protoNumber(1, 1026),
          ...protoNumber(2, 12),
          ...protoNumber(3, 3),
          ...protoText(11, "retry-1"),
        ];
        const generation = protoBytes(1, [
          ...protoBytes(4, usage),
          ...protoText(19, "Gemini 3 Pro"),
          ...protoBytes(9, protoBytes(4, stamp)),
        ]);
        const step = [
          ...protoBytes(9, usage),
          ...protoBytes(8, stamp),
          ...protoBytes(28, protoBytes(2, retry)),
        ];
        yield* seedDatabase(path.join(dir, "session-1.db"), (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              0,
              new Uint8Array(generation),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [0, new Uint8Array(step)]);
          }),
        );
        const result = yield* readAntigravityUsage(dir, 0);
        assert.deepStrictEqual(result.errors, []);
        const read = records(result);
        assert.strictEqual(read.length, 2);
        const main = read.find((record) => record.model === "gemini-3-pro");
        assert.isDefined(main);
        assert.strictEqual(main?.timestampMs, 1780000000000);
        assert.strictEqual(main?.sessionId, "session-1");
        assert.deepStrictEqual(main?.totals, {
          uncachedInputTokens: 100,
          cachedInputTokens: 20,
          cacheCreationTokens: 5,
          outputTokens: 40,
          reasoningTokens: 10,
        });
        assert.strictEqual(
          read.find((record) => record.model === "claude-opus-4-6")?.totals.uncachedInputTokens,
          12,
        );
        assert.deepStrictEqual(records(yield* readAntigravityUsage(dir, 1780000000001)), []);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the matching Antigravity generation model for each model-less step", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "model-switch.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          for (const [idx, name] of ["Gemini 3 Pro", "Claude Opus 4.6"].entries()) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(1, protoText(19, name))),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(9, protoNumber(2, 10 + idx))),
            ]);
          }
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        records(result).map((record) => record.model),
        ["gemini-3-pro", "claude-opus-4-6"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prices ACP effort variants at the base model rate", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "effort.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          for (const [idx, name] of ["gemini-4-argon-high", "gemini-4-argon"].entries()) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(1, protoText(19, name))),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(9, protoNumber(2, 10 + idx))),
            ]);
          }
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(
        records(result).map(({ model, rateModel }) => [model, rateModel]),
        [
          ["gemini-4-argon-high", "gemini-4-argon"],
          ["gemini-4-argon", undefined],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("merges Antigravity aliases that bridge previously separate step records", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "bridge.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, [...protoNumber(2, 100), ...protoText(11, "response")])),
          ]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            1,
            new Uint8Array(protoBytes(9, [...protoNumber(3, 40), ...protoText(12, "provider")])),
          ]);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            0,
            new Uint8Array(
              protoBytes(1, [
                ...protoText(19, "Gemini 3 Pro"),
                ...protoBytes(4, [
                  ...protoNumber(2, 50),
                  ...protoNumber(5, 20),
                  ...protoText(11, "response"),
                  ...protoText(12, "provider"),
                ]),
              ]),
            ),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      const read = records(result);
      assert.strictEqual(read.length, 1);
      assert.deepStrictEqual(read[0]?.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 20,
        cacheCreationTokens: 0,
        outputTokens: 40,
        reasoningTokens: 0,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "merges Antigravity provider and message aliases across configured roots while keeping original ownership",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        const roots = [path.join(dir, "first"), path.join(dir, "second")];
        for (const [index, root] of roots.entries()) {
          yield* fileSystem.makeDirectory(root);
          yield* seedDatabase(path.join(root, `session-${index}.db`), (db) =>
            Effect.gen(function* () {
              yield* db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
              for (const identity of [7, 12]) {
                const usage = [
                  ...protoNumber(1, 246),
                  ...protoNumber(2, index === 0 ? 100 : 150),
                  ...protoText(11, `response-${index}-${identity}`),
                  ...protoText(identity, `shared-${identity}`),
                ];
                yield* db.run("INSERT INTO steps VALUES (?, ?)", [
                  identity,
                  new Uint8Array(protoBytes(9, usage)),
                ]);
              }
            }),
          );
        }
        const result = yield* readAntigravityUsage(roots, 0);
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.files.length, 2);
        assert.strictEqual(result.files[0]?.root, roots[0]);
        assert.strictEqual(result.files[0]?.records.length, 2);
        assert.strictEqual(result.files[1]?.records.length, 0);
        assert.deepStrictEqual(
          result.files[0]?.records.map((record) => record.totals.uncachedInputTokens),
          [150, 150],
        );
        assert.isTrue(result.files[0]?.records.every((record) => record.sessionId === "session-0"));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("upgrades Antigravity fallback timestamps before applying the date window", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      for (const fallback of ["mtime", "trajectory"]) {
        const file = path.join(dir, `${fallback}.db`);
        yield* seedDatabase(file, (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            if (fallback === "trajectory") {
              yield* db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB)");
              yield* db.run("INSERT INTO trajectory_metadata_blob VALUES (?)", [
                new Uint8Array(protoBytes(2, protoNumber(1, 1780000200))),
              ]);
            }
            for (const [index, seconds] of [1780000000, 1780000200].entries()) {
              const usage = [...protoNumber(2, 10), ...protoText(11, `${fallback}-${index}`)];
              yield* db.run("INSERT INTO steps VALUES (?, ?)", [
                index,
                new Uint8Array(protoBytes(9, usage)),
              ]);
              yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
                index,
                new Uint8Array(
                  protoBytes(1, [
                    ...protoBytes(4, usage),
                    ...protoBytes(9, protoBytes(4, protoNumber(1, seconds))),
                  ]),
                ),
              ]);
            }
          }),
        );
        yield* fileSystem.utimes(file, 1780000000, 1780000000);
      }
      const result = yield* readAntigravityUsage(dir, 1780000100000);
      assert.deepStrictEqual(result.errors, []);
      const read = records(result);
      assert.strictEqual(read.length, 2);
      assert.deepStrictEqual(
        read.map((record) => record.timestampMs),
        [1780000200000, 1780000200000],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const antigravityGeneration = (responseId: string) =>
    new Uint8Array(
      protoBytes(1, [
        ...protoBytes(4, [
          ...protoNumber(2, 100),
          ...protoNumber(3, 40),
          ...protoText(11, responseId),
        ]),
        ...protoText(19, "Gemini 3 Pro"),
        ...protoBytes(9, protoBytes(4, protoNumber(1, 1780000000))),
      ]),
    );

  it.effect("persists the service cache, retrying after a failed write, and restores it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempDir;
      const baseDir = path.join(root, "state");
      const configLayer = ServerConfig.layerTest(root, baseDir);
      const { stateDir } = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
      const conversations = path.join(root, "data", "conversations");
      yield* fileSystem.makeDirectory(conversations, { recursive: true });
      yield* seedDatabase(path.join(conversations, "session-1.db"), (db) =>
        db
          .exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)")
          .pipe(
            Effect.andThen(
              db.run("INSERT INTO gen_metadata VALUES (0, ?)", [antigravityGeneration("r-1")]),
            ),
          ),
      );
      // Open the database once so the scans below see a stable fingerprint.
      yield* readAntigravityUsage(conversations, 0);
      const cacheFile = path.join(stateDir, ANTIGRAVITY_USAGE_CACHE_FILE_NAME);
      const instances = [
        {
          instanceId: ProviderInstanceId.make("antigravity"),
          config: undefined,
          environment: { ANTIGRAVITY_DATA_DIR: path.join(root, "data") },
          configured: false,
        },
      ];
      let failures = 1;
      const flakyFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (inner) => ({
          ...inner,
          // Writing under a missing directory fails with a real PlatformError.
          writeFileString: (target: string, contents: string) =>
            failures-- > 0
              ? inner.writeFileString(path.join(target, "missing", "file"), contents)
              : inner.writeFileString(target, contents),
        })),
      );
      const layer = AntigravityUsage.layer.pipe(
        Layer.provideMerge(flakyFileSystem),
        Layer.provideMerge(ProviderHostLive.layer),
        Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
        Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(ServerSettings.layerTest({})),
        Layer.provideMerge(NodeServices.layer),
      );
      const withService = <A, E>(
        use: (
          scan: () => Effect.Effect<
            Effect.Success<ReturnType<AntigravityUsage.AntigravityUsage["Service"]["scan"]>>
          >,
        ) => Effect.Effect<A, E>,
      ) =>
        Effect.gen(function* () {
          const service = yield* AntigravityUsage.AntigravityUsage;
          return yield* use(() => service.scan({ instances, windowStartMs: 0 }).pipe(Effect.orDie));
        }).pipe(Effect.provide(layer));
      // One service: the first write fails, and an unchanged second scan must write again.
      const first = yield* withService((scan) =>
        Effect.gen(function* () {
          const result = yield* scan();
          assert.isFalse(yield* fileSystem.exists(cacheFile));
          yield* scan();
          return result;
        }),
      );
      const saved = yield* fileSystem.readFileString(cacheFile);
      const databases = (yield* decodeAntigravityUsageCache(saved)).databases;
      assert.strictEqual(Object.keys(databases).length, 1);
      // A new service on the same state dir must take its records from the saved file, not a rescan:
      // an edited cached record shows up in the result while the database fingerprint is unchanged.
      const edited = JSON.parse(saved);
      for (const entry of Object.values<any>(edited.databases)) {
        for (const candidate of entry.candidates)
          candidate.record.sessionId = "restored-from-cache";
      }
      yield* fileSystem.writeFileString(cacheFile, JSON.stringify(edited));
      const restored = yield* withService((scan) => scan());
      assert.notInclude(JSON.stringify(first), "restored-from-cache");
      assert.include(JSON.stringify(restored), "restored-from-cache");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rereads an Antigravity database when only its WAL changed", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const dir = yield* tempDir;
      const path = pathService.join(dir, "session-1.db");
      const db = yield* openDatabase(path);
      yield* db.exec("PRAGMA journal_mode = WAL");
      yield* db.exec("PRAGMA wal_autocheckpoint = 0");
      yield* db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      const insert = (idx: number, responseId: string) =>
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", [idx, antigravityGeneration(responseId)]);
      yield* insert(0, "r-1");
      const cache = makeAntigravityUsageCache();
      const first = yield* readAntigravityUsage(dir, 0, cache);
      assert.strictEqual(records(first).length, 1);

      const before = yield* Effect.promise(() => NodeFSP.stat(path));
      yield* insert(1, "r-2");
      const after = yield* Effect.promise(() => NodeFSP.stat(path));
      assert.strictEqual(after.size, before.size);
      assert.strictEqual(after.mtimeMs, before.mtimeMs);

      const next = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(
        records(next).map((record) => record.dedupeKey),
        ["antigravity:11:r-1", "antigravity:11:r-2"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restores a persisted cache without rereading unchanged databases", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const path = (yield* Path.Path).join(dir, "session-1.db");
      yield* seedDatabase(path, (db) =>
        db
          .exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)")
          .pipe(
            Effect.andThen(
              db.run("INSERT INTO gen_metadata VALUES (0, ?)", [antigravityGeneration("r-1")]),
            ),
          ),
      );
      const cache = makeAntigravityUsageCache();
      const first = yield* readAntigravityUsage(dir, 0, cache);
      const saved = yield* encodeAntigravityUsageCache(cache);
      const restored = makeAntigravityUsageCache();
      for (const [key, entry] of Object.entries(
        (yield* decodeAntigravityUsageCache(saved)).databases,
      )) {
        restored.set(key, entry);
      }
      const [entry] = restored.values();
      assert.deepStrictEqual(yield* readAntigravityUsage(dir, 0, restored), first);
      assert.strictEqual([...restored.values()][0], entry);
      // Unreadable files, and files written for another MODEL_IDS table, are not used.
      for (const bad of ["{", saved.replace(/"models":"[^"]*"/, '"models":""')]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeAntigravityUsageCache(bad))));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads Antigravity step-only stores and reports malformed databases", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "steps.db"), (db) =>
        Effect.gen(function* () {
          yield* db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
          const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...protoNumber(3, 5)];
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array([...protoBytes(9, usage), ...protoBytes(8, protoNumber(1, 1780000000))]),
          ]);
        }),
      );
      yield* fileSystem.writeFileString(path.join(dir, "broken.db"), "not a sqlite database");
      const result = yield* readAntigravityUsage(dir, 0);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(records(result)[0]?.model, "gemini-2.5-pro");
      assert.strictEqual(records(result)[0]?.totals.outputTokens, 5);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores large values in unused Antigravity protobuf fields", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "large-varint.db"), (db) =>
        Effect.gen(function* () {
          yield* db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
          const unusedField = [...protoNumber(99, 0).slice(0, -1), ...Array(9).fill(0xff), 0x01];
          const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...unusedField];
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, usage)),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.strictEqual(records(result)[0]?.totals.uncachedInputTokens, 10);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const stepUsage = (responseId: string) =>
    new Uint8Array(protoBytes(9, [...protoNumber(2, 10), ...protoText(11, responseId)]));

  it.effect("returns Antigravity records in idx order however the rows are stored", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "session-1.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.exec("BEGIN");
          for (let idx = 99; idx >= 0; idx--) {
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [idx, stepUsage(`s-${idx}`)]);
          }
          for (const idx of [1, 0]) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              antigravityGeneration(`g-${idx}`),
            ]);
          }
          yield* db.exec("COMMIT");
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        records(result).map((record) => record.dedupeKey),
        [
          ...Array.from({ length: 100 }, (_, idx) => `antigravity:11:s-${idx}`),
          "antigravity:11:g-0",
          "antigravity:11:g-1",
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
