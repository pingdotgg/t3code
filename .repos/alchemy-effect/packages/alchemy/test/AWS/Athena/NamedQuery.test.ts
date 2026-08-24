import * as AWS from "@/AWS";
import { NamedQuery } from "@/AWS/Athena/NamedQuery.ts";
import * as Test from "@/Test/Alchemy";
import * as athena from "@distilled.cloud/aws/athena";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getNamedQuery = (id: string) =>
  athena.getNamedQuery({ NamedQueryId: id }).pipe(
    Effect.map((res) => res.NamedQuery),
    Effect.catchTag("NamedQueryNotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "lifecycle: create, update in place, replace on database change, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — saved against the always-present `primary` workgroup.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* NamedQuery("LifecycleNQ", {
            name: "alchemy-test-named-query",
            database: "default",
            queryString: "SELECT 1",
            description: "initial",
          });
        }),
      );
      expect(created.namedQueryId).toBeTruthy();
      expect(created.workGroup).toBe("primary");

      const observed = yield* getNamedQuery(created.namedQueryId);
      expect(observed?.Name).toBe("alchemy-test-named-query");
      expect(observed?.QueryString).toBe("SELECT 1");
      expect(observed?.Description).toBe("initial");

      // Update in place — name/description/queryString mutate, id is stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* NamedQuery("LifecycleNQ", {
            name: "alchemy-test-named-query-v2",
            database: "default",
            queryString: "SELECT 2",
            description: "updated",
          });
        }),
      );
      expect(updated.namedQueryId).toBe(created.namedQueryId);
      const observedUpdated = yield* getNamedQuery(created.namedQueryId);
      expect(observedUpdated?.Name).toBe("alchemy-test-named-query-v2");
      expect(observedUpdated?.QueryString).toBe("SELECT 2");

      // Replace — changing `database` mints a new NamedQueryId.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* NamedQuery("LifecycleNQ", {
            name: "alchemy-test-named-query-v2",
            database: "information_schema",
            queryString: "SELECT 2",
            description: "updated",
          });
        }),
      );
      expect(replaced.namedQueryId).not.toBe(created.namedQueryId);
      // Old one is deleted as part of replacement.
      const oldGone = yield* getNamedQuery(created.namedQueryId);
      expect(oldGone).toBeUndefined();

      // Destroy — the saved query is removed.
      yield* stack.destroy();
      const after = yield* getNamedQuery(replaced.namedQueryId);
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
