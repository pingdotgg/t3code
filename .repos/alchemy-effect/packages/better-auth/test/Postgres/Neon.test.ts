import { RuntimeContext } from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { BetterAuth, Database } from "@/index.ts";
import { applyMigrations } from "@/Migrate.ts";
import { Postgres } from "@/Postgres.ts";

const { test } = Test.make({ providers: Neon.providers() });

const baseOptions = {
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
  secret: "test-secret-test-secret-test-secret",
} as const;

test.provider(
  "Postgres layer: migrate + auth roundtrip against Neon",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const project = yield* stack.deploy(Neon.Project("BetterAuthPgProject"));

      // resolved connection string — the same layer users feed an Output
      const layer = Postgres(project.connectionUri);
      const db = yield* Database.pipe(Effect.provide(layer));
      expect(db.migrate).toBeDefined();

      const first = yield* applyMigrations(db.migrate!, baseOptions);
      expect(first.tablesCreated).toBeGreaterThan(0);
      const second = yield* applyMigrations(db.migrate!, baseOptions);
      expect(second.tablesCreated).toBe(0);
      expect(second.tablesAltered).toBe(0);

      // full auth flow against the real Neon Postgres, in-process (bun
      // provides the execution scope the per-execution pool rides on)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* BetterAuth(baseOptions);
          const signUp = yield* auth.api.signUpEmail({
            body: {
              email: "neon@example.com",
              password: "password1234",
              name: "Neon User",
            },
          });
          expect(signUp.user.email).toBe("neon@example.com");
          const signIn = yield* auth.api.signInEmail({
            body: { email: "neon@example.com", password: "password1234" },
          });
          expect(signIn.token).toBeDefined();
        }).pipe(Effect.provide(layer)),
      );

      yield* stack.destroy();
    }).pipe(Effect.provide(RuntimeContext.phantom)),
  { timeout: 120_000 },
);
