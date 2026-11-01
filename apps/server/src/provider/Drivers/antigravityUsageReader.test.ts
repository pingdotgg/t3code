// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's File.Info has no ctime or sub-millisecond mtime, which the cache tests compare.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { makeAntigravityUsageCache, readAntigravityUsage } from "./antigravityUsageReader.ts";

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

  const attemptUsage = (scale: number, ids: number[] = []) => [
    ...protoNumber(2, 100 * scale),
    ...protoNumber(3, 40 * scale),
    ...protoNumber(4, 5 * scale),
    ...protoNumber(5, 20 * scale),
    ...protoNumber(9, 10 * scale),
    ...protoNumber(10, 30 * scale),
    ...ids,
  ];
  const usageRow = (
    source: "step" | "generation",
    main: number[],
    attempts: number[][] = [],
    model = "gemini-3.1-pro",
    seconds = 1780000000,
  ) => {
    const step = source === "step";
    const data = [
      ...protoBytes(step ? 9 : 4, main),
      ...attempts.flatMap((usage) => protoBytes(step ? 28 : 17, protoBytes(2, usage))),
      ...(step ? protoBytes(24, protoText(12, model)) : protoText(19, model)),
      ...(step
        ? protoBytes(8, protoNumber(1, seconds))
        : protoBytes(9, protoBytes(4, protoNumber(1, seconds)))),
    ];
    return new Uint8Array(step ? data : protoBytes(1, data));
  };
  const readUsageRows = Effect.fnUntraced(function* (
    steps: Uint8Array[],
    generations: Uint8Array[],
  ) {
    const path = yield* Path.Path;
    const dir = yield* tempDir;
    yield* seedDatabase(path.join(dir, "attempts.db"), (db) =>
      Effect.gen(function* () {
        yield* createTables(db);
        for (const [index, row] of steps.entries()) {
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [7 + index * 2, row]);
        }
        for (const [index, row] of generations.entries()) {
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [index, row]);
        }
      }),
    );
    const result = yield* readAntigravityUsage(dir, 0);
    assert.deepStrictEqual(result.errors, []);
    return records(result);
  });
  const attemptTotals = (scale: number) => ({
    uncachedInputTokens: 100 * scale,
    cachedInputTokens: 20 * scale,
    cacheCreationTokens: 5 * scale,
    outputTokens: 40 * scale,
    reasoningTokens: 10 * scale,
  });

  it.effect.each([
    { name: "retry attempts", attempts: [1, 2], step: "gemini-3.1-pro", gen: "gemini-3.1-pro" },
    {
      name: "single call with Gemini variant labels",
      attempts: [1],
      step: "gemini-3.8-flash-high",
      gen: "gemini-3.8-flash-n",
    },
  ])(
    "counts $name once across main, attempt, step and generation copies",
    ({ attempts, step, gen }) =>
      Effect.gen(function* () {
        const usages = attempts.map((scale) => attemptUsage(scale));
        const read = yield* readUsageRows(
          usages.map((usage) => usageRow("step", usage, [usage], step)),
          [
            usageRow(
              "generation",
              attemptUsage(attempts.reduce((a, b) => a + b, 0)),
              usages,
              gen,
              1780000010,
            ),
          ],
        );
        assert.deepStrictEqual(
          read.map(({ totals, model, timestampMs }) => ({ totals, model, timestampMs })),
          attempts.map((scale) => ({
            totals: attemptTotals(scale),
            model: step,
            timestampMs: 1780000000000,
          })),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  const response = protoText(11, "response");
  const aliases = [response, protoText(12, "provider"), protoText(7, "message")];
  it.effect.each([
    {
      name: "preserves main response aliases when the single attempt has none",
      steps: [usageRow("step", attemptUsage(1, aliases.flat()), [attemptUsage(1)])],
      generations: aliases.map((alias) => usageRow("generation", attemptUsage(1, alias))),
      expected: [1],
    },
    {
      name: "keeps the aggregate when retries share a response ID",
      steps: [],
      generations: [
        usageRow("generation", attemptUsage(3, response), [
          attemptUsage(1, response),
          attemptUsage(2, response),
        ]),
      ],
      expected: [3],
    },
    {
      name: "keeps equal-counter attempts with different response IDs separate",
      steps: [],
      generations: [
        usageRow("generation", attemptUsage(1, response), [
          attemptUsage(1, protoText(11, "other")),
        ]),
      ],
      expected: [1, 1],
    },
    {
      name: "keeps retry IDs in their response and provider namespaces",
      steps: [],
      generations: [
        usageRow("generation", attemptUsage(3, [...response, ...protoText(12, "response")]), [
          attemptUsage(1, response),
          attemptUsage(2, protoText(12, "response")),
        ]),
      ],
      expected: [1, 2],
    },
  ])("$name", ({ steps, generations, expected }) =>
    Effect.gen(function* () {
      const read = yield* readUsageRows(steps, generations);
      assert.deepStrictEqual(
        read.map((record) => record.totals),
        expected.map(attemptTotals),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      name: "different models with missing copies",
      steps: [
        ["claude-opus-4-6", 1780000000],
        ["gemini-3.1-pro", 1780000000],
      ],
      generations: [
        ["gemini-3.1-pro", 1780000010],
        ["claude-sonnet-4-6", 1780000010],
      ],
      expected: [
        ["claude-opus-4-6", 1780000000],
        ["gemini-3.1-pro", 1780000000],
        ["claude-sonnet-4-6", 1780000010],
      ],
    },
    {
      name: "distant timestamps with missing copies",
      steps: [
        ["gemini-3.1-pro", 1780000000],
        ["gemini-3.1-pro", 1780086400],
      ],
      generations: [
        ["gemini-3.1-pro", 1780086410],
        ["gemini-3.1-pro", 1780172810],
      ],
      expected: [
        ["gemini-3.1-pro", 1780000000],
        ["gemini-3.1-pro", 1780086400],
        ["gemini-3.1-pro", 1780172810],
      ],
    },
    {
      name: "ambiguous copies without model evidence",
      steps: [
        ["", 1780000000],
        ["", 1780000000],
      ],
      generations: [
        ["", 1780000010],
        ["", 1780000010],
      ],
      expected: [
        ["antigravity-unknown", 1780000000],
        ["antigravity-unknown", 1780000000],
        ["antigravity-unknown", 1780000010],
        ["antigravity-unknown", 1780000010],
      ],
    },
    {
      name: "ambiguous copies without timestamp evidence",
      steps: [
        ["gemini-3.1-pro", 0],
        ["gemini-3.1-pro", 0],
      ],
      generations: [
        ["gemini-3.1-pro", 0],
        ["gemini-3.1-pro", 0],
      ],
      expected: [
        ["gemini-3.1-pro", 0],
        ["gemini-3.1-pro", 0],
        ["gemini-3.1-pro", 0],
        ["gemini-3.1-pro", 0],
      ],
    },
    {
      name: "multiple plausible partners with model and timestamp evidence",
      steps: [
        ["gemini-3.1-pro", 1780000000],
        ["gemini-3.1-pro", 1780000020],
      ],
      generations: [["gemini-3.1-pro", 1780000010]],
      expected: [
        ["gemini-3.1-pro", 1780000000],
        ["gemini-3.1-pro", 1780000020],
        ["gemini-3.1-pro", 1780000010],
      ],
    },
  ] as const)(
    "does not infer identity from equal counters: $name",
    ({ steps, generations, expected }) =>
      Effect.gen(function* () {
        const read = yield* readUsageRows(
          steps.map(([model, seconds]) => usageRow("step", attemptUsage(1), [], model, seconds)),
          generations.map(([model, seconds]) =>
            usageRow("generation", attemptUsage(1), [], model, seconds),
          ),
        );
        assert.deepStrictEqual(
          read.map((record) => record.totals),
          expected.map(() => attemptTotals(1)),
        );
        assert.deepStrictEqual(
          read.map(({ model, timestampMs }) => [model, steps[0][1] === 0 ? 0 : timestampMs / 1000]),
          expected.map((entry) => [...entry]),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      name: "retains differing source model labels despite a shared usage model enum",
      stepModel: "claude-opus-4-6",
      generationModel: "claude-sonnet-4-6",
      stepEnum: 1016,
      generationEnum: 1016,
      expectedModels: ["gemini-3.1-pro", "gemini-3.1-pro"],
    },
    {
      name: "retains differing usage model enums despite a shared source model label",
      stepModel: "claude-opus-4-6",
      generationModel: "claude-opus-4-6",
      stepEnum: 1016,
      generationEnum: 1026,
      expectedModels: ["gemini-3.1-pro", "claude-opus-4-6"],
    },
  ])("$name", ({ stepModel, generationModel, stepEnum, generationEnum, expectedModels }) =>
    Effect.gen(function* () {
      const read = yield* readUsageRows(
        [usageRow("step", attemptUsage(1, protoNumber(1, stepEnum)), [], stepModel)],
        [
          usageRow(
            "generation",
            attemptUsage(1, protoNumber(1, generationEnum)),
            [],
            generationModel,
            1780000010,
          ),
        ],
      );
      assert.strictEqual(read.length, 2);
      assert.deepStrictEqual(
        read.map((record) => record.totals),
        [attemptTotals(1), attemptTotals(1)],
      );
      assert.deepStrictEqual(
        read.map((record) => record.model),
        expectedModels,
      );
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
