// @effect-diagnostics nodeBuiltinImport:off - builds isolated SQLite fixtures in temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, expect, it } from "@effect/vitest";

import { scanShareableArtifact } from "../privacy.ts";
import { importOpenCodeCorpus } from "./opencode.ts";

async function createFixture(options: { eventTable?: boolean; malformedPart?: boolean } = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-opencode-import-"));
  const sourcePath = NodePath.join(root, "source.sqlite");
  const database = new NodeSqlite.DatabaseSync(sourcePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id),
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id),
      session_id TEXT NOT NULL REFERENCES session(id),
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  if (options.eventTable !== false) {
    database.exec(`
      CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE event (
        id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id),
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  const insertSession = database.prepare("INSERT INTO session (id, title) VALUES (?, ?)");
  const insertMessage = database.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  );
  const insertPart = database.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  );
  const insertSequence =
    options.eventTable === false
      ? undefined
      : database.prepare("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?)");
  const insertEvent =
    options.eventTable === false
      ? undefined
      : database.prepare(
          "INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)",
        );

  for (let index = 0; index < 25; index += 1) {
    const sessionId = `session-${index.toString().padStart(2, "0")}`;
    const messageId = `message-${index.toString().padStart(2, "0")}`;
    insertSession.run(sessionId, `private title ${index}`);
    insertMessage.run(
      messageId,
      sessionId,
      index,
      JSON.stringify({ role: "user", private: `Bearer private-secret-${index}` }),
    );
    insertPart.run(
      `part-${index.toString().padStart(2, "0")}`,
      messageId,
      sessionId,
      index,
      options.malformedPart && index === 24
        ? `{ malformed ${"x".repeat(2_000)}`
        : JSON.stringify({ type: "text", text: "x".repeat(100 + index * 20) }),
    );
    insertSequence?.run(sessionId, 2);
    insertEvent?.run(
      `event-${index}-2`,
      sessionId,
      2,
      "session.updated",
      JSON.stringify({ text: `private transcript ${index} second` }),
    );
    insertEvent?.run(
      `event-${index}-1`,
      sessionId,
      1,
      "session.updated",
      JSON.stringify({ text: `private transcript ${index} first` }),
    );
  }
  database.close();
  return { root, sourcePath };
}

describe("OpenCode local corpus importer", () => {
  it("snapshots read-only state and selects exactly the 20 largest final render sessions", async () => {
    const fixture = await createFixture();
    const before = await NodeFSP.readFile(fixture.sourcePath);
    const result = await importOpenCodeCorpus({
      sourceDatabasePath: fixture.sourcePath,
      privateDirectory: NodePath.join(fixture.root, "private-import"),
    });

    assert.equal(result.sessions.length, 20);
    assert.deepStrictEqual(
      result.sessions.map((session) => session.sourceSessionId),
      Array.from(
        { length: 20 },
        (_, offset) => `session-${(24 - offset).toString().padStart(2, "0")}`,
      ),
    );
    assert(
      result.sessions.every(
        (session) => session.events.map((event) => event.sequence).join() === "1,2",
      ),
    );
    assert.deepStrictEqual(await NodeFSP.readFile(fixture.sourcePath), before);
    await expect(NodeFSP.access(result.snapshotPath)).rejects.toThrow();
    assert.equal(
      (await NodeFSP.stat(NodePath.join(fixture.root, "private-import"))).mode & 0o777,
      0o700,
    );
    assert.deepStrictEqual(scanShareableArtifact(result.shareableSummary), []);
    expect(JSON.stringify(result.shareableSummary)).not.toMatch(/private|Bearer|session-24/u);
    await NodeFSP.rm(fixture.root, { recursive: true });
  });

  it("represents a missing optional event table with empty histories", async () => {
    const fixture = await createFixture({ eventTable: false });
    const result = await importOpenCodeCorpus({
      sourceDatabasePath: fixture.sourcePath,
      privateDirectory: NodePath.join(fixture.root, "private-import"),
    });
    assert(result.sessions.every((session) => session.events.length === 0));
    await NodeFSP.rm(fixture.root, { recursive: true });
  });

  it("resolves equal-size sessions by source ID", async () => {
    const fixture = await createFixture({ eventTable: false });
    const database = new NodeSqlite.DatabaseSync(fixture.sourcePath);
    database
      .prepare("UPDATE part SET data = ? WHERE id IN ('part-23', 'part-24')")
      .run(JSON.stringify({ type: "text", text: "same-size".repeat(1_000) }));
    database.close();
    const result = await importOpenCodeCorpus({
      sourceDatabasePath: fixture.sourcePath,
      privateDirectory: NodePath.join(fixture.root, "private-import"),
    });
    const tied = result.sessions
      .filter(
        (session) =>
          session.sourceSessionId === "session-23" || session.sourceSessionId === "session-24",
      )
      .map((session) => session.sourceSessionId);
    assert.deepStrictEqual(tied, ["session-23", "session-24"]);
    await NodeFSP.rm(fixture.root, { recursive: true });
  });

  it("aborts malformed data without leaving a snapshot or shareable artifact", async () => {
    const fixture = await createFixture({ malformedPart: true });
    const privateDirectory = NodePath.join(fixture.root, "private-import");
    await expect(
      importOpenCodeCorpus({ sourceDatabasePath: fixture.sourcePath, privateDirectory }),
    ).rejects.toThrow(/malformed JSON/u);
    const files = await NodeFSP.readdir(privateDirectory);
    assert.deepStrictEqual(files, []);
    await NodeFSP.rm(fixture.root, { recursive: true });
  });

  it("rejects unsupported row versions and inconsistent foreign keys", async () => {
    const versioned = await createFixture({ eventTable: false });
    const versionedDatabase = new NodeSqlite.DatabaseSync(versioned.sourcePath);
    versionedDatabase
      .prepare("UPDATE part SET data = ? WHERE id = 'part-24'")
      .run(JSON.stringify({ schemaVersion: 2, type: "text", text: "x".repeat(2_000) }));
    versionedDatabase.close();
    await expect(
      importOpenCodeCorpus({
        sourceDatabasePath: versioned.sourcePath,
        privateDirectory: NodePath.join(versioned.root, "private-import"),
      }),
    ).rejects.toThrow(/unsupported schema version 2/u);
    await NodeFSP.rm(versioned.root, { recursive: true });

    const inconsistent = await createFixture({ eventTable: false });
    const inconsistentDatabase = new NodeSqlite.DatabaseSync(inconsistent.sourcePath);
    inconsistentDatabase
      .prepare("UPDATE part SET message_id = 'message-23' WHERE id = 'part-24'")
      .run();
    inconsistentDatabase.close();
    await expect(
      importOpenCodeCorpus({
        sourceDatabasePath: inconsistent.sourcePath,
        privateDirectory: NodePath.join(inconsistent.root, "private-import"),
      }),
    ).rejects.toThrow(/inconsistent message\/session foreign key/u);
    await NodeFSP.rm(inconsistent.root, { recursive: true });
  });
});
