import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "@effect/vitest";

import {
  parseRelayDatabaseUrl,
  relayDatabaseMode,
  relayDatabaseProviderConfig,
} from "./dbConfig.ts";

const readProvider = (env: Record<string, string>) =>
  relayDatabaseProviderConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.result,
  );

describe("relayDatabaseProviderConfig", () => {
  it.effect.each([
    [{}, "planetscale"],
    [{ RELAY_DATABASE_PROVIDER: "" }, "planetscale"],
    [{ RELAY_DATABASE_PROVIDER: " external " }, "external"],
  ] as const)("reads %j as %s", ([env, expected]) =>
    Effect.gen(function* () {
      expect(yield* readProvider(env)).toEqual(expect.objectContaining({ success: expected }));
    }),
  );

  it.effect("rejects an unknown provider", () =>
    Effect.gen(function* () {
      expect((yield* readProvider({ RELAY_DATABASE_PROVIDER: "neon" }))._tag).toBe("Failure");
    }),
  );
});

describe("relayDatabaseMode", () => {
  it("branches PlanetScale per stage and keeps an external database to prod", () => {
    expect(relayDatabaseMode("prod")).toBe("shared-database");
    expect(relayDatabaseMode("dev_julius")).toBe("stage-branch");
    expect(relayDatabaseMode("prod", "external")).toBe("external");
    expect(() => relayDatabaseMode("pr-12", "external")).toThrow(/only the prod stage/);
  });
});

describe("parseRelayDatabaseUrl", () => {
  it("reads a Neon direct URL into a Hyperdrive origin", () => {
    const origin = parseRelayDatabaseUrl(
      Redacted.make(
        "postgresql://relay%40owner:p%2Fss@ep-cool-1.us-west-2.aws.neon.tech/relay?sslmode=require&channel_binding=require",
      ),
    );
    expect({ ...origin, password: Redacted.value(origin.password) }).toEqual({
      scheme: "postgres",
      host: "ep-cool-1.us-west-2.aws.neon.tech",
      port: 5432,
      database: "relay",
      user: "relay@owner",
      password: "p/ss",
    });
    expect(
      parseRelayDatabaseUrl(Redacted.make("postgres://u:p@db.example.com:6543/app")).port,
    ).toBe(6543);
  });

  it.each([
    ["not a url", /does not parse/],
    ["mysql://u:secret@db.example.com/app", /scheme/],
    ["postgres://u:secret@db.example.com/", /no database/],
    ["postgres://db.example.com/app", /no user and password/],
  ])("rejects %s without echoing it", (url, reason) => {
    const parse = () => parseRelayDatabaseUrl(Redacted.make(url));
    expect(parse).toThrow(reason);
    expect(parse).not.toThrow(/secret/);
  });
});
