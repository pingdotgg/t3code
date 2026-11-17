import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { readOpenCodeSessions } from "./OpenCodeSessionDatabase.ts";

const tempDirs: string[] = [];
const makeDatabase = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-"));
  tempDirs.push(directory);
  const file = NodePath.join(directory, "opencode.db");
  return { file, db: new NodeSqlite.DatabaseSync(file) };
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("readOpenCodeSessions", () => {
  it("reads V2 session_message rows without touching the database", () => {
    const { file, db } = makeDatabase();
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL,
        directory TEXT NOT NULL, title TEXT, model TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
        seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE session_part (
        message_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        type TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (message_id, ordinal)
      );
      INSERT INTO session_v2 VALUES (
        'ses_v2', 'project_1', 'test-session', '/workspace', 'V2 session',
        '{"providerID":"openai","id":"gpt-6"}', 1794900000000, 1794900300000
      );
      INSERT INTO session_message VALUES
        ('msg1', 'ses_v2', 'user', 1, 1794900000000, 1794900000000, '{}'),
        ('msg2', 'ses_v2', 'assistant', 2, 1794900300000, 1794900300000, '{}');
      INSERT INTO session_part VALUES
        ('msg1', 'ses_v2', 0, 'text', '{"text":"Hello"}'),
        ('msg2', 'ses_v2', 0, 'text', '{"text":"Hi there"}');
    `);
    db.close();

    expect(readOpenCodeSessions(file)).toMatchObject([{
      providerSessionId: "ses_v2",
      directory: "/workspace",
      title: "V2 session",
      model: "openai/gpt-6",
      messages: [
        { role: "user", text: "Hello" },
        { role: "assistant", text: "Hi there" },
      ],
    }]);
  });

  it("reads legacy V1 message and text-part rows", () => {
    const { file, db } = makeDatabase();
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT,
        time_created INTEGER, time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, sessionID TEXT, data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT
      );
      INSERT INTO session VALUES ('ses_v1', '/legacy', 'V1 session', NULL, 1794900000000, 1794900300000);
      INSERT INTO message VALUES ('m1', 'ses_v1', '{"role":"user"}');
      INSERT INTO part VALUES ('p1', 'm1', 'ses_v1', '{"type":"text","text":"Legacy hello"}');
    `);
    db.close();

    expect(readOpenCodeSessions(file)).toMatchObject([{
      providerSessionId: "ses_v1",
      directory: "/legacy",
      messages: [{ role: "user", text: "Legacy hello" }],
    }]);
  });

  it("prefers V2 and safely ignores an unrelated database", () => {
    const { file, db } = makeDatabase();
    db.exec("CREATE TABLE unrelated (id TEXT)");
    db.close();
    expect(readOpenCodeSessions(file)).toEqual([]);
  });
});
