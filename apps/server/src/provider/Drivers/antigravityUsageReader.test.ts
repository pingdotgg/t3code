// @effect-diagnostics nodeBuiltinImport:off - the reader under test opens real
// SQLite databases, mirroring the reader's own deliberate node:sqlite usage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import { makeAntigravityUsageCache, readAntigravityUsage } from "./antigravityUsageReader.ts";

let dir: string;

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

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-reader-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

describe("readAntigravityUsage", () => {
  it("deduplicates Antigravity generation and step usage while preserving retry model and token buckets", async () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "session-1.db"));
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
    try {
      db.exec(
        "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)",
      );
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(0, new Uint8Array(generation));
      db.prepare("INSERT INTO steps VALUES (?, ?)").run(0, new Uint8Array(step));
    } finally {
      db.close();
    }
    const result = await readAntigravityUsage(dir, 0);
    assert.deepStrictEqual(result.errors, []);
    const records = result.files.flatMap((file) => file.records);
    assert.strictEqual(records.length, 2);
    const main = records.find((record) => record.model === "gemini-3-pro");
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
      records.find((record) => record.model === "claude-opus-4-6")?.totals.uncachedInputTokens,
      12,
    );
    assert.deepStrictEqual(
      (await readAntigravityUsage(dir, 1780000000001)).files.flatMap((file) => file.records),
      [],
    );
  });

  it("uses the matching Antigravity generation model for each model-less step", async () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "model-switch.db"));
    try {
      db.exec(
        "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)",
      );
      const generation = db.prepare("INSERT INTO gen_metadata VALUES (?, ?)");
      const step = db.prepare("INSERT INTO steps VALUES (?, ?)");
      for (const [idx, name] of ["Gemini 3 Pro", "Claude Opus 4.6"].entries()) {
        generation.run(idx, new Uint8Array(protoBytes(1, protoText(19, name))));
        step.run(idx, new Uint8Array(protoBytes(9, protoNumber(2, 10 + idx))));
      }
    } finally {
      db.close();
    }
    const result = await readAntigravityUsage(dir, 0);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(
      result.files.flatMap((file) => file.records).map((record) => record.model),
      ["gemini-3-pro", "claude-opus-4-6"],
    );
  });

  it("merges Antigravity aliases that bridge previously separate step records", async () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "bridge.db"));
    try {
      db.exec(
        "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)",
      );
      const step = db.prepare("INSERT INTO steps VALUES (?, ?)");
      step.run(
        0,
        new Uint8Array(protoBytes(9, [...protoNumber(2, 100), ...protoText(11, "response")])),
      );
      step.run(
        1,
        new Uint8Array(protoBytes(9, [...protoNumber(3, 40), ...protoText(12, "provider")])),
      );
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(
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
      );
    } finally {
      db.close();
    }
    const result = await readAntigravityUsage(dir, 0);
    assert.deepStrictEqual(result.errors, []);
    const records = result.files.flatMap((file) => file.records);
    assert.strictEqual(records.length, 1);
    assert.deepStrictEqual(records[0]?.totals, {
      uncachedInputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 0,
      outputTokens: 40,
      reasoningTokens: 0,
    });
  });

  it("merges Antigravity provider and message aliases across configured roots while keeping original ownership", async () => {
    const roots = [NodePath.join(dir, "first"), NodePath.join(dir, "second")];
    for (const [index, root] of roots.entries()) {
      await NodeFSP.mkdir(root);
      const db = new NodeSqlite.DatabaseSync(NodePath.join(root, `session-${index}.db`));
      try {
        db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
        for (const identity of [7, 12]) {
          const usage = [
            ...protoNumber(1, 246),
            ...protoNumber(2, index === 0 ? 100 : 150),
            ...protoText(11, `response-${index}-${identity}`),
            ...protoText(identity, `shared-${identity}`),
          ];
          db.prepare("INSERT INTO steps VALUES (?, ?)").run(
            identity,
            new Uint8Array(protoBytes(9, usage)),
          );
        }
      } finally {
        db.close();
      }
    }
    const result = await readAntigravityUsage(roots, 0);
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
  });

  it("upgrades Antigravity fallback timestamps before applying the date window", async () => {
    for (const fallback of ["mtime", "trajectory"]) {
      const path = NodePath.join(dir, `${fallback}.db`);
      const db = new NodeSqlite.DatabaseSync(path);
      try {
        db.exec(
          "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)",
        );
        if (fallback === "trajectory") {
          db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB)");
          db.prepare("INSERT INTO trajectory_metadata_blob VALUES (?)").run(
            new Uint8Array(protoBytes(2, protoNumber(1, 1780000200))),
          );
        }
        for (const [index, seconds] of [1780000000, 1780000200].entries()) {
          const usage = [...protoNumber(2, 10), ...protoText(11, `${fallback}-${index}`)];
          db.prepare("INSERT INTO steps VALUES (?, ?)").run(
            index,
            new Uint8Array(protoBytes(9, usage)),
          );
          db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(
            index,
            new Uint8Array(
              protoBytes(1, [
                ...protoBytes(4, usage),
                ...protoBytes(9, protoBytes(4, protoNumber(1, seconds))),
              ]),
            ),
          );
        }
      } finally {
        db.close();
      }
      await NodeFSP.utimes(path, 1780000000, 1780000000);
    }
    const result = await readAntigravityUsage(dir, 1780000100000);
    assert.deepStrictEqual(result.errors, []);
    const records = result.files.flatMap((file) => file.records);
    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(
      records.map((record) => record.timestampMs),
      [1780000200000, 1780000200000],
    );
  });

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

  it("reuses an unchanged Antigravity database instead of decoding it again", async () => {
    const path = NodePath.join(dir, "session-1.db");
    const db = new NodeSqlite.DatabaseSync(path);
    try {
      db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(0, antigravityGeneration("r-1"));
      const cache = makeAntigravityUsageCache();
      assert.deepStrictEqual((await readAntigravityUsage(dir, 0, cache)).errors, []);

      // An exclusive lock makes a fresh read fail without touching the file, so
      // only a cache hit can still return the earlier records.
      db.exec("BEGIN EXCLUSIVE");
      assert.strictEqual((await readAntigravityUsage(dir, 0)).errors.length, 1);
      const cached = await readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(cached.errors, []);
      assert.deepStrictEqual(
        cached.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["antigravity:11:r-1"],
      );
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  });

  it("rereads an Antigravity database rewritten with its size and mtime restored", async () => {
    const path = NodePath.join(dir, "session-1.db");
    const db = new NodeSqlite.DatabaseSync(path);
    try {
      db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(0, antigravityGeneration("r-1"));
    } finally {
      db.close();
    }
    await NodeFSP.utimes(path, 1780000000, 1780000000);
    const cache = makeAntigravityUsageCache();
    assert.deepStrictEqual((await readAntigravityUsage(dir, 0, cache)).errors, []);

    // ctime has the kernel's timestamp granularity, which can be a few
    // milliseconds, so repeat the forged rewrite until it lands on a later tick
    // than the cached read, as any real rewrite does.
    const cached = await NodeFSP.stat(path);
    do {
      await NodeFSP.writeFile(path, Buffer.alloc(cached.size));
      await NodeFSP.utimes(path, 1780000000, 1780000000);
    } while ((await NodeFSP.stat(path)).ctimeMs === cached.ctimeMs);
    const restored = await NodeFSP.stat(path);
    assert.strictEqual(restored.size, cached.size);
    assert.strictEqual(restored.mtimeMs, cached.mtimeMs);
    const next = await readAntigravityUsage(dir, 0, cache);
    assert.deepStrictEqual(next.errors, [path]);
    assert.deepStrictEqual(
      next.files.flatMap((file) => file.records),
      [],
    );
  });

  it("rereads an Antigravity database when only its WAL changed", async () => {
    const path = NodePath.join(dir, "session-1.db");
    const db = new NodeSqlite.DatabaseSync(path);
    try {
      db.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE gen_metadata (idx INTEGER, data BLOB)",
      );
      const insert = db.prepare("INSERT INTO gen_metadata VALUES (?, ?)");
      insert.run(0, antigravityGeneration("r-1"));
      const cache = makeAntigravityUsageCache();
      const first = await readAntigravityUsage(dir, 0, cache);
      assert.strictEqual(first.files.flatMap((file) => file.records).length, 1);

      const before = await NodeFSP.stat(path);
      insert.run(1, antigravityGeneration("r-2"));
      const after = await NodeFSP.stat(path);
      assert.strictEqual(after.size, before.size);
      assert.strictEqual(after.mtimeMs, before.mtimeMs);

      const next = await readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(
        next.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["antigravity:11:r-1", "antigravity:11:r-2"],
      );
    } finally {
      db.close();
    }
  });

  it("reads Antigravity step-only stores and reports malformed databases", async () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "steps.db"));
    try {
      db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
      const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...protoNumber(3, 5)];
      db.prepare("INSERT INTO steps VALUES (?, ?)").run(
        0,
        new Uint8Array([...protoBytes(9, usage), ...protoBytes(8, protoNumber(1, 1780000000))]),
      );
    } finally {
      db.close();
    }
    await NodeFSP.writeFile(NodePath.join(dir, "broken.db"), "not a sqlite database");
    const result = await readAntigravityUsage(dir, 0);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.files.flatMap((file) => file.records)[0]?.model, "gemini-2.5-pro");
    assert.strictEqual(result.files.flatMap((file) => file.records)[0]?.totals.outputTokens, 5);
  });

  it("ignores large values in unused Antigravity protobuf fields", async () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "large-varint.db"));
    try {
      db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
      const unusedField = [...protoNumber(99, 0).slice(0, -1), ...Array(9).fill(0xff), 0x01];
      const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...unusedField];
      db.prepare("INSERT INTO steps VALUES (?, ?)").run(0, new Uint8Array(protoBytes(9, usage)));
    } finally {
      db.close();
    }
    const result = await readAntigravityUsage(dir, 0);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(
      result.files.flatMap((file) => file.records)[0]?.totals.uncachedInputTokens,
      10,
    );
  });
});
