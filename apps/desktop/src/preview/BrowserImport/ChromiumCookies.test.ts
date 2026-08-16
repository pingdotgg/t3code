// @effect-diagnostics nodeBuiltinImport:off - Encrypts fixtures with the same
// OSCrypt primitives the module under test decrypts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  decryptChromiumValue,
  readChromiumCookieDatabase,
  readChromiumCookies,
} from "./ChromiumCookies.ts";
import { ChromiumKeyError } from "./ChromiumKeys.ts";
import { LinuxBrowserSecretPath } from "./LinuxBrowserSecret.ts";
import { cookieScope } from "./CookieDatabase.ts";

const encryptChromium = (
  prefix: "v10" | "v11",
  value: string | Buffer,
  key: Buffer,
): Uint8Array => {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(prefix), cipher.update(value), cipher.final()]);
};

const encryptV10 = (value: string | Buffer, key: Buffer): Uint8Array =>
  encryptChromium("v10", value, key);

const encryptWindowsV10 = (value: string | Buffer, key: Buffer): Uint8Array => {
  const nonce = Buffer.from("0123456789ab");
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, encrypted, cipher.getAuthTag()]);
};

describe("cookieScope", () => {
  it("keeps a host-only cookie host-only", () => {
    // Chromium stores a host-only cookie without a leading dot. Passing any
    // `domain` to Electron makes it a domain cookie and re-adds the dot, which
    // would expose the cookie to every subdomain it was never scoped to.
    expect(cookieScope("example.test", "/", true)).toEqual({
      url: "https://example.test/",
      domain: undefined,
    });
  });

  it("preserves a domain cookie's leading dot", () => {
    expect(cookieScope(".example.test", "/app", true)).toEqual({
      url: "https://example.test/app",
      domain: ".example.test",
    });
  });

  it("matches the scheme to the secure flag", () => {
    expect(cookieScope("example.test", "/", false).url).toBe("http://example.test/");
  });

  it("brackets bare IPv6 hosts without duplicating existing brackets", () => {
    expect(cookieScope("::1", "/", false)).toEqual({
      url: "http://[::1]/",
      domain: undefined,
    });
    expect(cookieScope("[::1]", "/app", true)).toEqual({
      url: "https://[::1]/app",
      domain: undefined,
    });
  });
});

describe("readChromiumCookieDatabase", () => {
  it("decrypts Windows v10 AES-GCM records and rejects app-bound v20 records", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef");
    const host = ".example.test";
    const bound = Buffer.concat([
      NodeCrypto.createHash("sha256").update(host).digest(),
      Buffer.from("windows value"),
    ]);

    expect(
      decryptChromiumValue(encryptWindowsV10(bound, key), { gcmV10: key }, host, 24, "win32"),
    ).toBe("windows value");
    expect(
      decryptChromiumValue(Buffer.from("v20app-bound"), { gcmV10: key }, host, 24, "win32"),
    ).toBeNull();
    expect(
      decryptChromiumValue(
        encryptWindowsV10(bound, Buffer.alloc(32, 1)),
        { gcmV10: key },
        host,
        24,
        "win32",
      ),
    ).toBeNull();
  });

  it.effect(
    "reports the missing key when no cookies can be read, while preserving partial imports",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-missing-key-",
        });
        const filename = `${directory}/Cookies`;
        const key = Buffer.from("0123456789abcdef");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`create table meta (key text primary key, value text not null)`;
          yield* sql`insert into meta values ('version', 23)`;
          yield* sql`create table cookies (
          host_key text not null, name text not null, value text not null,
          encrypted_value blob not null, path text not null, expires_utc integer not null,
          is_secure integer not null, is_httponly integer not null, samesite integer not null,
          top_frame_site_key text not null default ''
        )`;
          yield* sql`insert into cookies values ('v11.example', 'session', '', ${encryptChromium("v11", "secret", key)}, '/', 0, 1, 1, 1, '')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

        const error = yield* readChromiumCookies({
          cookieDatabasePath: filename,
          platform: "linux",
          linuxSecretApplication: "chromium",
          keychainService: undefined,
          keychainAccount: undefined,
        }).pipe(Effect.provideService(LinuxBrowserSecretPath, undefined), Effect.flip);
        expect(error.reason).toBe("keychainUnavailable");

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`insert into cookies values ('v10.example', 'readable', '', ${encryptV10("kept", key)}, '/', 0, 1, 1, 1, '')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
        const keys = {
          cbcV10: key,
          cbcV11Error: new ChromiumKeyError({ reason: "keychainUnavailable" }),
        };
        const partial = yield* readChromiumCookieDatabase(filename, keys, "linux");
        expect(partial.cookies.map((cookie) => cookie.value)).toEqual(["kept"]);
        expect(partial.undecryptable).toBe(1);

        // A partitioned-only jar does not need its key: it is skipped separately.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`delete from cookies where name = 'readable'`;
          yield* sql`update cookies set top_frame_site_key = 'https://top.example'`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
        const partitioned = yield* readChromiumCookieDatabase(filename, keys, "linux");
        expect(partitioned.cookies).toEqual([]);
        expect(partitioned.undecryptable).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads plaintext, encrypted, and genuinely empty cookie values", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-chromium-cookies-",
      });
      const filename = `${directory}/Cookies`;
      const key = Buffer.from("0123456789abcdef");

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value text not null)`;
        yield* sql`insert into meta values ('version', 23)`;
        yield* sql`
          create table cookies (
            host_key text not null,
            name text not null,
            value text not null,
            encrypted_value blob not null,
            path text not null,
            expires_utc integer not null,
            is_secure integer not null,
            is_httponly integer not null,
            samesite integer not null,
            top_frame_site_key text not null default ''
          )
        `;
        yield* sql`
          insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
            ('plain.example', 'plain', 'stored plaintext', ${new Uint8Array()}, '/', 0, 0, 0, -1)
        `;
        yield* sql`
          insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
            ('secure.example', 'encrypted', '', ${encryptV10("stored encrypted", key)}, '/', 0, 1, 1, 2)
        `;
        yield* sql`
          insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
            ('empty.example', 'empty', '', ${new Uint8Array()}, '/', 0, 0, 0, 0)
        `;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      const result = yield* readChromiumCookieDatabase(filename, { cbcV10: key }, "darwin");

      expect(result.undecryptable).toBe(0);
      expect(result.cookies.map(({ name, value }) => ({ name, value }))).toEqual([
        { name: "plain", value: "stored plaintext" },
        { name: "encrypted", value: "stored encrypted" },
        { name: "empty", value: "" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("enforces domain binding only for schema 24 and newer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-chromium-cookies-",
      });
      const filename = `${directory}/Cookies`;
      const key = Buffer.from("0123456789abcdef");
      const boundValue = (host: string, value: string) =>
        Buffer.concat([NodeCrypto.createHash("sha256").update(host).digest(), Buffer.from(value)]);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value text not null)`;
        yield* sql`insert into meta values ('version', 24)`;
        yield* sql`
          create table cookies (
            host_key text not null, name text not null, value text not null,
            encrypted_value blob not null, path text not null, expires_utc integer not null,
            is_secure integer not null, is_httponly integer not null, samesite integer not null,
            top_frame_site_key text not null default ''
          )
        `;
        yield* sql`insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
          ('bound.example', 'valid', '', ${encryptV10(boundValue("bound.example", "kept"), key)}, '/', 0, 1, 0, 0)`;
        yield* sql`insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
          ('wrong.example', 'mismatch', '', ${encryptV10(boundValue("another.example", "drop"), key)}, '/', 0, 1, 0, 0)`;
        yield* sql`insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
          ('short.example', 'short', '', ${encryptV10("short value", key)}, '/', 0, 1, 0, 0)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      const result = yield* readChromiumCookieDatabase(filename, { cbcV10: key }, "darwin");

      expect(result.cookies.map(({ name, value }) => ({ name, value }))).toEqual([
        { name: "valid", value: "kept" },
      ]);
      expect(result.undecryptable).toBe(2);
      expect(result.undecryptableHosts).toEqual(["wrong.example", "short.example"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("decrypts mixed v10 and v11 cookies with their respective keys", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-chromium-cookies-",
      });
      const filename = `${directory}/Cookies`;
      const cbcV10 = Buffer.from("0123456789abcdef");
      const cbcV11 = Buffer.from("fedcba9876543210");
      const boundValue = (host: string, value: string) =>
        Buffer.concat([NodeCrypto.createHash("sha256").update(host).digest(), Buffer.from(value)]);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value text not null)`;
        yield* sql`insert into meta values ('version', '24')`;
        yield* sql`
          create table cookies (
            host_key text not null, name text not null, value text not null,
            encrypted_value blob not null, path text not null, expires_utc integer not null,
            is_secure integer not null, is_httponly integer not null, samesite integer not null,
            top_frame_site_key text not null default ''
          )
        `;
        yield* sql`insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
          ('v10.example', 'v10-cookie', '', ${encryptChromium("v10", boundValue("v10.example", "v10 value"), cbcV10)}, '/', 0, 1, 0, 0)`;
        yield* sql`insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
          ('v11.example', 'v11-cookie', '', ${encryptChromium("v11", boundValue("v11.example", "v11 value"), cbcV11)}, '/', 0, 1, 0, 0)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      const complete = yield* readChromiumCookieDatabase(filename, { cbcV10, cbcV11 }, "linux");
      expect(complete.cookies.map(({ name, value }) => ({ name, value }))).toEqual([
        { name: "v10-cookie", value: "v10 value" },
        { name: "v11-cookie", value: "v11 value" },
      ]);
      expect(complete.undecryptable).toBe(0);

      const v10Only = yield* readChromiumCookieDatabase(filename, { cbcV10 }, "linux");
      expect(v10Only.cookies.map(({ name, value }) => ({ name, value }))).toEqual([
        { name: "v10-cookie", value: "v10 value" },
      ]);
      expect(v10Only.undecryptable).toBe(1);
      expect(v10Only.undecryptableHosts).toEqual(["v11.example"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("recovers records written with the empty-passphrase key", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-chromium-cookies-",
      });
      const filename = `${directory}/Cookies`;
      const cbcV10 = Buffer.from("0123456789abcdef");
      const cbcV11 = Buffer.from("fedcba9876543210");
      // The key some Linux clients actually encrypted with (crbug.com/1195256):
      // OSCrypt's derivation over an empty passphrase.
      const cbcEmpty = NodeCrypto.pbkdf2Sync("", "saltysalt", 1, 16, "sha1");

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value text not null)`;
        yield* sql`insert into meta values ('version', '23')`;
        yield* sql`
          create table cookies (
            host_key text not null, name text not null, value text not null,
            encrypted_value blob not null, path text not null, expires_utc integer not null,
            is_secure integer not null, is_httponly integer not null, samesite integer not null,
            top_frame_site_key text not null default ''
          )
        `;
        yield* sql`insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
          ('ev10.example', 'empty-v10', '', ${encryptChromium("v10", "empty v10 value", cbcEmpty)}, '/', 0, 1, 0, 0)`;
        yield* sql`insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
          ('ev11.example', 'empty-v11', '', ${encryptChromium("v11", "empty v11 value", cbcEmpty)}, '/', 0, 1, 0, 0)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      // The records' own keys fail, and the empty key recovers both — the
      // retry Chromium itself performs.
      const recovered = yield* readChromiumCookieDatabase(
        filename,
        { cbcV10, cbcV11, cbcEmpty },
        "linux",
      );
      expect(recovered.cookies.map(({ name, value }) => ({ name, value }))).toEqual([
        { name: "empty-v10", value: "empty v10 value" },
        { name: "empty-v11", value: "empty v11 value" },
      ]);
      expect(recovered.undecryptable).toBe(0);

      // Matching Chromium: a record whose own key is missing entirely is not
      // retried with the empty key.
      const noV11 = yield* readChromiumCookieDatabase(filename, { cbcV10, cbcEmpty }, "linux");
      expect(noV11.cookies.map(({ name }) => name)).toEqual(["empty-v10"]);
      expect(noV11.undecryptableHosts).toEqual(["ev11.example"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("preserves arbitrary long encrypted values from pre-24 schemas", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-chromium-cookies-",
      });
      const filename = `${directory}/Cookies`;
      const key = Buffer.from("0123456789abcdef");
      const value = "x".repeat(32) + " legacy value";

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value text not null)`;
        yield* sql`insert into meta values ('version', 23)`;
        yield* sql`
          create table cookies (
            host_key text not null, name text not null, value text not null,
            encrypted_value blob not null, path text not null, expires_utc integer not null,
            is_secure integer not null, is_httponly integer not null, samesite integer not null,
            top_frame_site_key text not null default ''
          )
        `;
        yield* sql`insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
          ('legacy.example', 'legacy', '', ${encryptV10(value, key)}, '/', 0, 0, 0, 0)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      const result = yield* readChromiumCookieDatabase(filename, { cbcV10: key }, "darwin");
      expect(result.cookies[0]?.value).toBe(value);
      expect(result.undecryptable).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("rejects a malformed text schema version", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-chromium-cookies-",
      });
      const filename = `${directory}/Cookies`;

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value text not null)`;
        yield* sql`insert into meta values ('version', 'not-a-version')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      const error = yield* readChromiumCookieDatabase(
        filename,
        { cbcV10: Buffer.from("0123456789abcdef") },
        "darwin",
      ).pipe(Effect.flip);

      expect(error._tag).toBe("SchemaError");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("treats unversioned encrypted values as legacy plaintext on macOS and Linux", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-chromium-cookies-",
      });
      const filename = `${directory}/Cookies`;
      const key = Buffer.from("0123456789abcdef");

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value integer not null)`;
        yield* sql`insert into meta values ('version', 23)`;
        yield* sql`
          create table cookies (
            host_key text not null, name text not null, value text not null,
            encrypted_value blob not null, path text not null, expires_utc integer not null,
            is_secure integer not null, is_httponly integer not null, samesite integer not null,
            top_frame_site_key text not null default ''
          )
        `;
        yield* sql`insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) values
          ('legacy.example', 'legacy', '', ${Buffer.from("legacy cleartext")}, '/', 0, 0, 0, 0)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      // Chromium's OSCrypt returns unprefixed data as-is on both platforms
      // (os_crypt_mac.mm and os_crypt_linux.cc: "old data saved as clear
      // text"), so neither counts it as undecryptable.
      const mac = yield* readChromiumCookieDatabase(filename, { cbcV10: key }, "darwin");
      const linux = yield* readChromiumCookieDatabase(filename, { cbcV10: key }, "linux");

      expect(mac.cookies[0]?.value).toBe("legacy cleartext");
      expect(mac.undecryptable).toBe(0);
      expect(linux.cookies[0]?.value).toBe("legacy cleartext");
      expect(linux.undecryptable).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("skips partitioned cookies without breaking pre-CHIPS schemas", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-chromium-cookies-",
      });
      const legacyFilename = `${directory}/LegacyCookies`;
      const chipsFilename = `${directory}/ChipsCookies`;
      const key = Buffer.from("0123456789abcdef");

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value integer not null)`;
        yield* sql`insert into meta values ('version', 14)`;
        yield* sql`
          create table cookies (
            host_key text not null, name text not null, value text not null,
            encrypted_value blob not null, path text not null, expires_utc integer not null,
            is_secure integer not null, is_httponly integer not null, samesite integer not null
          )
        `;
        yield* sql`insert into cookies values
          ('legacy.example', 'legacy', 'kept', ${new Uint8Array()}, '/', 0, 0, 0, 0)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: legacyFilename })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table meta (key text primary key, value integer not null)`;
        yield* sql`insert into meta values ('version', 23)`;
        yield* sql`
          create table cookies (
            host_key text not null, name text not null, value text not null,
            encrypted_value blob not null, path text not null, expires_utc integer not null,
            is_secure integer not null, is_httponly integer not null, samesite integer not null,
            top_frame_site_key text not null
          )
        `;
        yield* sql`insert into cookies values
          ('plain.example', 'plain', 'kept', ${new Uint8Array()}, '/', 0, 0, 0, 0, '')`;
        yield* sql`insert into cookies values
          ('partitioned.example', 'partitioned', 'must skip', ${new Uint8Array()}, '/', 0, 1, 0, 0, 'https://top.example')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: chipsFilename })));

      const legacy = yield* readChromiumCookieDatabase(legacyFilename, { cbcV10: key }, "darwin");
      const chips = yield* readChromiumCookieDatabase(chipsFilename, { cbcV10: key }, "darwin");

      expect(legacy.cookies.map(({ name }) => name)).toEqual(["legacy"]);
      expect(legacy.undecryptable).toBe(0);
      expect(chips.cookies.map(({ name }) => name)).toEqual(["plain"]);
      expect(chips.undecryptable).toBe(1);
      expect(chips.undecryptableHosts).toEqual(["partitioned.example"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
