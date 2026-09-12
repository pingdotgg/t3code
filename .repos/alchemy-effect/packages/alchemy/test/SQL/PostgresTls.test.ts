import { resolveSsl } from "@/SQL/PostgresTls.ts";
import { describe, expect, it } from "alchemy-test";
import * as Redacted from "effect/Redacted";

const url = (s: string) => Redacted.make(s);

describe("SQL/PostgresTls resolveSsl", () => {
  it("resolves sslmode=prefer|allow to TLS on when ssl is implicit", () => {
    for (const mode of ["prefer", "allow"]) {
      expect(
        resolveSsl(
          url(`postgres://u@ep-x.neon.tech/x?sslmode=${mode}`),
          undefined,
        ),
      ).toBe(true);
      expect(
        resolveSsl(
          url(`postgres://u@127.0.0.1:5432/x?sslmode=${mode}`),
          undefined,
        ),
      ).toBe(true);
    }
  });

  it("leaves every other URL to @effect/sql-pg", () => {
    expect(
      resolveSsl(url("postgres://u@db.example.com/x"), undefined),
    ).toBeUndefined();
    for (const mode of ["disable", "require", "verify-ca", "verify-full"]) {
      expect(
        resolveSsl(
          url(`postgres://u@db.example.com/x?sslmode=${mode}`),
          undefined,
        ),
      ).toBeUndefined();
    }
  });

  it("never overrides an explicit ssl option", () => {
    const explicit = { rejectUnauthorized: false, servername: "override" };
    expect(
      resolveSsl(url("postgres://u@db.example.com/x?sslmode=prefer"), explicit),
    ).toBe(explicit);
    expect(
      resolveSsl(url("postgres://u@db.example.com/x?sslmode=prefer"), false),
    ).toBe(false);
    expect(
      resolveSsl(url("postgres://u@db.example.com/x?sslmode=require"), true),
    ).toBe(true);
  });

  it("passes malformed URLs through untouched", () => {
    expect(resolveSsl(url("not a url"), undefined)).toBeUndefined();
    expect(resolveSsl(url("not a url"), true)).toBe(true);
  });
});
