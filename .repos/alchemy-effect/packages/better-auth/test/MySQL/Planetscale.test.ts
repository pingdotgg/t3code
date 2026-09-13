import { RuntimeContext } from "alchemy";
import * as Planetscale from "alchemy/Planetscale";
import * as Test from "alchemy/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { BetterAuth, Database } from "@/index.ts";
import { applyMigrations } from "@/Migrate.ts";
import { MySQL } from "@/MySQL.ts";

const { test } = Test.make({ providers: Planetscale.providers() });

const baseOptions = {
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
  secret: "test-secret-test-secret-test-secret",
} as const;

test.provider(
  "MySQL layer: migrate + auth roundtrip against PlanetScale",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { database, password } = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* Planetscale.MySQLDatabase("BetterAuthMySQL", {
            clusterSize: "PS_10",
          });
          const password = yield* Planetscale.MySQLPassword(
            "BetterAuthMySQLPassword",
            { database, role: "admin" },
          );
          return { database, password };
        }),
      );

      // PlanetScale requires TLS — mysql2 parses the `ssl` query param
      const url =
        `mysql://${password.username}:${Redacted.value(password.password)}` +
        `@${password.host}/${database.name}` +
        `?ssl=${encodeURIComponent('{"rejectUnauthorized":true}')}`;

      const layer = MySQL(url);
      const db = yield* Database.pipe(Effect.provide(layer));
      expect(db.migrate).toBeDefined();

      const first = yield* applyMigrations(db.migrate!, baseOptions);
      expect(first.tablesCreated).toBeGreaterThan(0);
      const second = yield* applyMigrations(db.migrate!, baseOptions);
      expect(second.tablesCreated).toBe(0);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* BetterAuth(baseOptions);
          const signUp = yield* auth.api.signUpEmail({
            body: {
              email: "planetscale@example.com",
              password: "password1234",
              name: "PlanetScale User",
            },
          });
          expect(signUp.user.email).toBe("planetscale@example.com");
          const signIn = yield* auth.api.signInEmail({
            body: {
              email: "planetscale@example.com",
              password: "password1234",
            },
          });
          expect(signIn.token).toBeDefined();
        }).pipe(Effect.provide(layer)),
      );

      yield* stack.destroy();
    }).pipe(Effect.provide(RuntimeContext.phantom)),
  { timeout: 120_000 },
);
