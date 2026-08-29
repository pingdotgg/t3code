// @effect-diagnostics nodeBuiltinImport:off - Encrypts a fixture with the same
// OSCrypt primitive as Chromium.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { cookieScope, readChromiumCookieDatabase } from "./ChromiumCookies.ts";

const encryptV10 = (value: string, key: Buffer): Uint8Array => {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
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
});

describe("readChromiumCookieDatabase", () => {
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
            samesite integer not null
          )
        `;
        yield* sql`
          insert into cookies values
            ('plain.example', 'plain', 'stored plaintext', ${new Uint8Array()}, '/', 0, 0, 0, -1)
        `;
        yield* sql`
          insert into cookies values
            ('secure.example', 'encrypted', '', ${encryptV10("stored encrypted", key)}, '/', 0, 1, 1, 2)
        `;
        yield* sql`
          insert into cookies values
            ('empty.example', 'empty', '', ${new Uint8Array()}, '/', 0, 0, 0, 0)
        `;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      const result = yield* readChromiumCookieDatabase(filename, key);

      expect(result.undecryptable).toBe(0);
      expect(result.cookies.map(({ name, value }) => ({ name, value }))).toEqual([
        { name: "plain", value: "stored plaintext" },
        { name: "encrypted", value: "stored encrypted" },
        { name: "empty", value: "" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
