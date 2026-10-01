import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { resolveConnectionOptions, resolveSsl } from "@/SQL/PostgresTls.ts";
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

describe("SQL/PostgresTls resolveConnectionOptions", () => {
  const railwayUrl = url(
    "postgresql://user:p%40ss@db.railway.internal:5432/railway?sslmode=no-verify&connect_timeout=7&application_name=app",
  );

  it("preserves Railway no-verify TLS semantics in a driver-compatible URL", () => {
    const options = resolveConnectionOptions(railwayUrl);
    const parsed = new URL(Redacted.value(options.url));
    expect(parsed.searchParams.get("sslmode")).toBe("require");
    expect(parsed.searchParams.get("connect_timeout")).toBe("7");
    expect(parsed.searchParams.get("application_name")).toBe("app");
    expect(parsed.password).toBe("p%40ss");
    expect(options.ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(Redacted.value(railwayUrl)).toContain("sslmode=no-verify");
  });

  it("passes Railway URLs through the actual driver parser before opening a transport", async () => {
    const stopped = new Error("Local transport sentinel");
    let attempted = false;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql`select 1`;
      }).pipe(
        Effect.provide(
          PgClient.layer({
            ...resolveConnectionOptions(railwayUrl),
            stream: () => {
              attempted = true;
              throw stopped;
            },
          }),
        ),
        Effect.scoped,
        Effect.result,
      ),
    );
    expect(attempted).toBe(true);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason.cause).toBe(stopped);
    }
  });

  it("keeps explicitly configured verification and SNI authoritative", () => {
    expect(resolveConnectionOptions(railwayUrl, true).ssl).toBe(true);
    expect(
      resolveConnectionOptions(railwayUrl, {
        rejectUnauthorized: true,
        servername: "custom.example.com",
        ca: "test-ca",
      }).ssl,
    ).toEqual({
      rejectUnauthorized: true,
      servername: "custom.example.com",
      ca: "test-ca",
    });
    expect(resolveConnectionOptions(railwayUrl, false).ssl).toBe(false);
    expect(
      new URL(
        Redacted.value(resolveConnectionOptions(railwayUrl, false).url),
      ).searchParams.get("sslmode"),
    ).toBe("require");
  });

  it("does not invent SNI for a no-verify IP connection", () => {
    expect(
      resolveConnectionOptions(url("postgres://u@[::1]/db?sslmode=no-verify"))
        .ssl,
    ).toEqual({ rejectUnauthorized: false });
  });

  it("preserves unmodified and malformed URLs for driver validation", () => {
    for (const value of [
      "postgres://u@db.example/db?sslmode=verify-full",
      "not a url",
    ]) {
      const original = url(value);
      expect(resolveConnectionOptions(original).url).toBe(original);
    }
  });
});
