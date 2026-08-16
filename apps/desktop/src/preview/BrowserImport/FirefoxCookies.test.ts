// @effect-diagnostics nodeBuiltinImport:off - Builds a Firefox-shaped
// `cookies.sqlite` fixture with the same native bindings Firefox itself uses.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as NodeSqlite from "node:sqlite";

import { readFirefoxCookies } from "./FirefoxCookies.ts";
import { parseFirefoxProfiles } from "./Sources.ts";

/** Builds a `cookies.sqlite` with Firefox's real `moz_cookies` shape. */
const writeFirefoxCookieDatabase = Effect.fnUntraced(function* (
  rows: ReadonlyArray<{
    host: string;
    name: string;
    value: string;
    path: string;
    expiry: number;
    isSecure: number;
    isHttpOnly: number;
    sameSite: number;
  }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-test-" });
  const file = `${directory}/cookies.sqlite`;
  const database = new NodeSqlite.DatabaseSync(file);
  database.exec(
    `create table moz_cookies (
       id integer primary key, host text, name text, value text, path text,
       expiry integer, isSecure integer, isHttpOnly integer, sameSite integer
     )`,
  );
  const insert = database.prepare(
    `insert into moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.host,
      row.name,
      row.value,
      row.path,
      row.expiry,
      row.isSecure,
      row.isHttpOnly,
      row.sameSite,
    );
  }
  database.close();
  return file;
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("readFirefoxCookies", () => {
  it.effect("maps moz_cookies onto the shape Electron accepts", () =>
    run(
      Effect.gen(function* () {
        const file = yield* writeFirefoxCookieDatabase([
          {
            host: ".github.com",
            name: "session",
            value: "abc",
            path: "/",
            expiry: 1_800_000_000,
            isSecure: 1,
            isHttpOnly: 1,
            sameSite: 1,
          },
          {
            host: "example.test",
            name: "plain",
            value: "v",
            path: "/app",
            // Firefox writes 0 for a session cookie.
            expiry: 0,
            isSecure: 0,
            isHttpOnly: 0,
            sameSite: 0,
          },
        ]);

        const cookies = yield* readFirefoxCookies(file);

        expect(cookies).toEqual([
          {
            // The leading dot stays on the domain but not in the URL, which is
            // what Electron matches against.
            url: "https://github.com/",
            name: "session",
            value: "abc",
            domain: ".github.com",
            path: "/",
            secure: true,
            httpOnly: true,
            expirationDate: 1_800_000_000,
            sameSite: "lax",
          },
          {
            url: "http://example.test/app",
            name: "plain",
            value: "v",
            // Host-only in Firefox, so no `domain`: supplying one would make
            // Electron widen it to every subdomain of example.test.
            domain: undefined,
            path: "/app",
            secure: false,
            httpOnly: false,
            // Session cookies carry no expiry rather than one at the epoch.
            expirationDate: undefined,
            sameSite: "no_restriction",
          },
        ]);
      }),
    ),
  );

  it.effect("reads without mutating the source database", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const file = yield* writeFirefoxCookieDatabase([
          {
            host: "a.test",
            name: "n",
            value: "v",
            path: "/",
            expiry: 1_800_000_000,
            isSecure: 1,
            isHttpOnly: 0,
            sameSite: 2,
          },
        ]);
        const before = yield* fileSystem.stat(file);

        yield* readFirefoxCookies(file);

        // The browser's own file is snapshotted, never opened for writing.
        const after = yield* fileSystem.stat(file);
        expect(after.mtime).toEqual(before.mtime);
        expect(after.size).toBe(before.size);
      }),
    ),
  );
});

describe("parseFirefoxProfiles", () => {
  it("reads named profiles and ignores Install sections", () => {
    // `Install*` sections name a default profile but do not describe one, so
    // counting them would invent a profile whose directory does not exist.
    const parsed = parseFirefoxProfiles(
      [
        "[Install4F96D1932A9F858E]",
        "Default=Profiles/abcd1234.default-release",
        "Locked=1",
        "",
        "[Profile0]",
        "Name=default-release",
        "IsRelative=1",
        "Path=Profiles/abcd1234.default-release",
        "",
        "[Profile1]",
        "Name=Work",
        "IsRelative=0",
        "Path=/Volumes/External/firefox-work",
        "",
        "[General]",
        "StartWithLastProfile=1",
      ].join("\n"),
    );

    expect(parsed).toEqual([
      { directory: "Profiles/abcd1234.default-release", name: "default-release" },
      { directory: "/Volumes/External/firefox-work", name: "Work" },
    ]);
  });

  it("falls back to the path when a profile has no name", () => {
    expect(parseFirefoxProfiles(["[Profile0]", "Path=Profiles/x.default"].join("\n"))).toEqual([
      { directory: "Profiles/x.default", name: "Profiles/x.default" },
    ]);
  });
});
