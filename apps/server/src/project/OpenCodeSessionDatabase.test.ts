import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

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
        id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT,
        time_created INTEGER, time_updated INTEGER
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT,
        data TEXT, time_created INTEGER
      );
      INSERT INTO session_v2 VALUES (
        'ses_v2', '/workspace', 'V2 session',
        '{"providerID":"openai","id":"gpt-6"}', 1794900000000, 1794900300000
      );
      INSERT INTO session_message VALUES (
        'msg1', 'ses_v2', 1, 'user',
        '{"role":"user","content":[{"type":"text","text":"Hello"}]}', 1794900000000
      );
      INSERT INTO session_message VALUES (
        'msg2', 'ses_v2', 2, 'assistant',
        '{"role":"assistant","content":[{"type":"text","text":"Hi there"}]}', 1794900300000
      );
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
