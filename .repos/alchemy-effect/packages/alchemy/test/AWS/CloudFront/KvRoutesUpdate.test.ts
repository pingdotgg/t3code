import * as AWS from "@/AWS";
import { KeyValueStore, KvRoutesUpdate } from "@/AWS/CloudFront";
import { extractValue, withKvsRegion } from "@/AWS/CloudFront/common.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.CloudFront.KvRoutesUpdate", () => {
  // KvRoutesUpdate is an update operation that manages a single route entry
  // inside a JSON array stored at a KV store key. It is keyed entirely by
  // {store, namespace, key, entry} and has no enumeration API, so list() is
  // non-listable and returns [] cleanly.
  test.provider("list returns [] (non-listable)", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(KvRoutesUpdate);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  );

  test.provider(
    "create, update, and delete a routes document entry",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initialEntry = "site,mysite,*,/";

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const store = yield* KeyValueStore("RoutesStore", {
              comment: "kv-routes lifecycle",
            });
            const route = yield* KvRoutesUpdate("HomeRoute", {
              store: store.keyValueStoreArn,
              namespace: "app",
              key: "routes",
              entry: initialEntry,
            });
            return { store, route };
          }),
        );

        expect(deployed.route.store).toBe(deployed.store.keyValueStoreArn);
        expect(deployed.route.namespace).toBe("app");
        expect(deployed.route.key).toBe("routes");
        expect(deployed.route.entry).toBe(initialEntry);

        const described = yield* withKvsRegion(
          kvs.describeKeyValueStore({
            KvsARN: deployed.store.keyValueStoreArn,
          }),
        );
        expect(described.KvsARN).toBe(deployed.store.keyValueStoreArn);

        yield* assertRoutes(deployed.store.keyValueStoreArn, "app:routes", [
          initialEntry,
        ]);

        const updatedEntry = "site,mysite,*,/app";

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const store = yield* KeyValueStore("RoutesStore", {
              comment: "kv-routes lifecycle",
            });
            const route = yield* KvRoutesUpdate("HomeRoute", {
              store: store.keyValueStoreArn,
              namespace: "app",
              key: "routes",
              entry: updatedEntry,
            });
            return { store, route };
          }),
        );

        expect(updated.store.keyValueStoreArn).toBe(
          deployed.store.keyValueStoreArn,
        );
        expect(updated.route.entry).toBe(updatedEntry);

        yield* assertRoutes(updated.store.keyValueStoreArn, "app:routes", [
          updatedEntry,
        ]);

        yield* stack.destroy();
        yield* assertKeyValueStoreDeleted(deployed.store.keyValueStoreName);
      }),
    { timeout: 120_000 },
  );
});

const getRoutesDocument = (store: string, fullKey: string) =>
  withKvsRegion(kvs.getKey({ KvsARN: store, Key: fullKey })).pipe(
    Effect.map((resp) => JSON.parse(extractValue(resp.Value)) as string[]),
  );

const routesMatch = (got: string[], expected: string[]) =>
  got.length === expected.length &&
  expected.every((entry) => got.includes(entry));

const assertRoutes = (store: string, fullKey: string, expected: string[]) =>
  Effect.gen(function* () {
    const routes = yield* getRoutesDocument(store, fullKey).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("200 millis"),
        until: (got) => routesMatch(got, expected),
        times: 15,
      }),
    );
    expect(routes).toEqual(expected);
  });

const assertKeyValueStoreDeleted = (name: string) =>
  cloudfront.describeKeyValueStore({ Name: name }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("KeyValueStoreStillExists"))),
    Effect.catchTag("EntityNotFound", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "KeyValueStoreStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
