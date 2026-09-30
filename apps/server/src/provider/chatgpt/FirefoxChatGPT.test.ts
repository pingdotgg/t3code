// SQLite fixture verifies the browser's native cookie file format.
// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { FirefoxChatGPT, readChatGPTCookies } from "./FirefoxChatGPT.ts";

it("imports only normal ChatGPT cookies without changing the source database", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cookie-test-"));
  const source = NodePath.join(directory, "cookies.sqlite");
  const destination = NodePath.join(directory, "import.sqlite");
  try {
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec(`CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT,
      expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT);`);
    const insert = db.prepare(
      "INSERT INTO moz_cookies VALUES (?, ?, ?, '/', 9999999999, 1, 1, 0, ?)",
    );
    insert.run("__Secure-session-token", "test-session", ".chatgpt.com", "");
    insert.run("preference", "test-preference", "chatgpt.com", "");
    insert.run("private", "unrelated-secret", "example.com", "");
    insert.run("container", "container-secret", ".chatgpt.com", "^userContextId=1");
    db.close();
    const original = await NodeFSP.readFile(source);
    const cookies = await readChatGPTCookies(directory, destination);
    expect(cookies.map((cookie) => cookie.name)).toEqual(["__Secure-session-token", "preference"]);
    expect(await NodeFSP.readFile(source)).toEqual(original);
    const imported = new NodeSqlite.DatabaseSync(destination, { readOnly: true });
    try {
      expect(imported.prepare("SELECT COUNT(*) AS count FROM moz_cookies").get()?.count).toBe(2);
    } finally {
      imported.close();
    }
    const bytes = await NodeFSP.readFile(destination);
    expect(bytes.includes(Buffer.from("unrelated-secret"))).toBe(false);
    expect(bytes.includes(Buffer.from("container-secret"))).toBe(false);
    if (HostProcessPlatform.defaultValue() !== "win32")
      expect((await NodeFSP.stat(destination)).mode & 0o777).toBe(0o600);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("rejects profiles without a normal ChatGPT sign-in", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cookie-test-"));
  try {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "cookies.sqlite"));
    db.exec(`CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT,
      expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT);`);
    db.close();
    await expect(readChatGPTCookies(directory)).rejects.toThrow("Sign in to ChatGPT");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("reports a missing Firefox executable without hanging during cleanup", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cookie-test-"));
  const browser = new FirefoxChatGPT({
    profile: directory,
    binary: NodePath.join(directory, "missing-firefox"),
    headless: true,
  });
  try {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "cookies.sqlite"));
    db.exec(`CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT,
      expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT);
      INSERT INTO moz_cookies VALUES ('__Secure-session-token', 'test', '.chatgpt.com', '/', 9999999999, 1, 1, 0, '');`);
    db.close();
    await expect(browser.complete("test", new AbortController().signal)).rejects.toThrow(
      "Could not launch Firefox",
    );
  } finally {
    await browser.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
