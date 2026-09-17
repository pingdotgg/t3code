import * as AWS from "@/AWS";
import { KeyValueStore, KvEntries } from "@/AWS/CloudFront";
import { extractValue, withKvsRegion } from "@/AWS/CloudFront/common.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.CloudFront.KvEntries", () => {
  test.provider("list returns [] for the non-listable KvEntries resource", () =>
    Effect.gen(function* () {
      // KvEntries is keyed entirely by a parent store ARN + namespace and
      // represents managed data, so it has no enumeration API → list() is [].
      const provider = yield* Provider.findProvider(KvEntries);
      expect(yield* provider.list()).toEqual([]);
    }),
  );

  test.provider(
    "create, update, and delete namespaced entries",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initialEntries = {
          "/": "/index.html",
          "/about": "/about.html",
          "/old": "/old.html",
        };

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const store = yield* KeyValueStore("EntriesStore", {
              comment: "kv-entries lifecycle",
            });
            const entries = yield* KvEntries("Routes", {
              store: store.keyValueStoreArn,
              namespace: "routes",
              entries: initialEntries,
              purge: true,
            });
            return { store, entries };
          }),
        );

        expect(deployed.entries.store).toBe(deployed.store.keyValueStoreArn);
        expect(deployed.entries.namespace).toBe("routes");
        expect(deployed.entries.entries).toEqual(initialEntries);

        const described = yield* withKvsRegion(
          kvs.describeKeyValueStore({
            KvsARN: deployed.store.keyValueStoreArn,
          }),
        );
        expect(described.KvsARN).toBe(deployed.store.keyValueStoreArn);
        expect(described.ItemCount).toBeGreaterThanOrEqual(3);

        yield* assertEntries(deployed.store.keyValueStoreArn, "routes", {
          "/": "/index.html",
          "/about": "/about.html",
          "/old": "/old.html",
        });

        const updatedEntries = {
          "/": "/index.html",
          "/about": "/about-v2.html",
          "/contact": "/contact.html",
        };

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const store = yield* KeyValueStore("EntriesStore", {
              comment: "kv-entries lifecycle",
            });
            const entries = yield* KvEntries("Routes", {
              store: store.keyValueStoreArn,
              namespace: "routes",
              entries: updatedEntries,
              purge: true,
            });
            return { store, entries };
          }),
        );

        expect(updated.store.keyValueStoreArn).toBe(
          deployed.store.keyValueStoreArn,
        );
        expect(updated.entries.entries).toEqual(updatedEntries);

        yield* assertEntries(updated.store.keyValueStoreArn, "routes", {
          "/": "/index.html",
          "/about": "/about-v2.html",
          "/contact": "/contact.html",
        });

        yield* stack.destroy();
        yield* assertKeyValueStoreDeleted(deployed.store.keyValueStoreName);
      }),
    { timeout: 120_000 },
  );
});

const listNamespacedEntries = (store: string, namespace: string) =>
  withKvsRegion(
    Effect.gen(function* () {
      const prefix = `${namespace}:`;
      const out: Record<string, string> = {};
      let nextToken: string | undefined;
      do {
        const resp = yield* kvs.listKeys({
          KvsARN: store,
          NextToken: nextToken,
        });
        for (const item of resp.Items ?? []) {
          if (!item.Key.startsWith(prefix)) continue;
          out[item.Key.slice(prefix.length)] = extractValue(item.Value);
        }
        nextToken = resp.NextToken;
      } while (nextToken);
      return out;
    }),
  );

const getNamespacedEntry = (store: string, namespace: string, key: string) =>
  withKvsRegion(kvs.getKey({ KvsARN: store, Key: `${namespace}:${key}` })).pipe(
    Effect.map((resp) => extractValue(resp.Value)),
  );

const entriesMatch = (
  got: Record<string, string>,
  expected: Record<string, string>,
) => {
  const gotKeys = Object.keys(got).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    gotKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => got[key] === expected[key])
  );
};

const assertEntries = (
  store: string,
  namespace: string,
  expected: Record<string, string>,
) =>
  Effect.gen(function* () {
    const listed = yield* listNamespacedEntries(store, namespace).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("200 millis"),
        until: (got) => entriesMatch(got, expected),
        times: 15,
      }),
    );
    expect(listed).toEqual(expected);

    for (const [key, value] of Object.entries(expected)) {
      expect(yield* getNamespacedEntry(store, namespace, key)).toBe(value);
    }
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
