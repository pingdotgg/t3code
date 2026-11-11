import * as AWS from "@alchemy.run/aws";
import { KeyValueStore, KvEntries, KvRoutesUpdate } from "@alchemy.run/aws/CloudFront";
import { extractValue, withKvsRegion } from "@alchemy.run/aws/CloudFront/common";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { driftActions, repairDrift, waitForDrift } from "../drift.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe(
  "AWS.CloudFront.KvEntries",
  { tags: ["provider:aws", "provider:aws:cloudfront", "live"] },
  () => {
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
            kvs.describeKeyValueStore({ KvsARN: deployed.store.keyValueStoreArn }),
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

          expect(updated.store.keyValueStoreArn).toBe(deployed.store.keyValueStoreArn);
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

    test.provider(
      "delete without purge leaves keys it does not own",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // A Router's layout: the `routes` table and its inline route
          // metadata share the router namespace.
          const router = (withMetadata: boolean) =>
            Effect.gen(function* () {
              const store = yield* KeyValueStore("SharedStore", {
                comment: "kv-entries shared namespace",
              });
              yield* KvRoutesUpdate("Routes", {
                store: store.keyValueStoreArn,
                namespace: "router",
                key: "routes",
                entry: "url,router:29e7,,/api",
              });
              if (withMetadata) {
                yield* KvEntries("Metadata", {
                  store: store.keyValueStoreArn,
                  namespace: "router",
                  entries: { "29e7:metadata": "{}" },
                });
              }
              return { store };
            });

          const deployed = yield* stack.deploy(router(true));
          const store = deployed.store.keyValueStoreArn;
          yield* assertEntries(store, "router", {
            routes: JSON.stringify(["url,router:29e7,,/api"]),
            "29e7:metadata": "{}",
          });

          // Removing the last inline route deletes the KvEntries; the
          // routes table must survive.
          yield* stack.deploy(router(false));
          yield* assertEntries(store, "router", {
            routes: JSON.stringify(["url,router:29e7,,/api"]),
          });

          yield* stack.destroy();
          yield* assertKeyValueStoreDeleted(deployed.store.keyValueStoreName);
        }),
      { timeout: 120_000 },
    );
  },
);

const listNamespacedEntries = (store: string, namespace: string) =>
  withKvsRegion(
    Effect.gen(function* () {
      const prefix = `${namespace}:`;
      const out: Record<string, string> = {};
      let nextToken: string | undefined;
      do {
        const resp = yield* kvs.listKeys({ KvsARN: store, NextToken: nextToken });
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

const entriesMatch = (got: Record<string, string>, expected: Record<string, string>) => {
  const gotKeys = Object.keys(got).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    gotKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => got[key] === expected[key])
  );
};

// #2688: KvEntries and KvRoutesUpdate returned their persisted output from
// `read`, so edited, deleted or extra keys read as `unchanged`.
test.provider(
  "drift detects and repairs out-of-band key value store changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { store } = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* KeyValueStore("DriftStore", { comment: "kv drift" });
          yield* KvEntries("DriftEntries", {
            store: store.keyValueStoreArn,
            namespace: "routes",
            entries: { "/": "/index.html", "/about": "/about.html" },
            purge: true,
          });
          yield* KvRoutesUpdate("DriftRoute", {
            store: store.keyValueStoreArn,
            namespace: "app",
            key: "routes",
            entry: "site,app,*,/",
          });
          return { store };
        }),
      );
      const arn = store.keyValueStoreArn;
      const allUnchanged = (actions: Record<string, string | undefined>) =>
        Object.values(actions).every((action) => action === "unchanged");
      expect(allUnchanged(yield* driftActions(stack))).toBe(true);

      const write = (puts: kvs.PutKeyRequestListItem[], deletes: kvs.DeleteKeyRequestListItem[]) =>
        withKvsRegion(
          Effect.gen(function* () {
            const { ETag } = yield* kvs.describeKeyValueStore({ KvsARN: arn });
            yield* kvs.updateKeys({ KvsARN: arn, IfMatch: ETag, Puts: puts, Deletes: deletes });
          }),
        );
      yield* write(
        [
          { Key: "routes:/", Value: "/out-of-band.html" },
          { Key: "routes:/stray", Value: "/stray.html" },
          { Key: "app:routes", Value: "[]" },
        ],
        [{ Key: "routes:/about" }],
      );

      const drifted = yield* waitForDrift(stack, "DriftEntries", "drifted");
      expect(drifted?.attr?.entries).toEqual({ "/": "/out-of-band.html", "/stray": "/stray.html" });
      expect((yield* waitForDrift(stack, "DriftRoute", "missing"))?.action).toBe("missing");

      yield* repairDrift(stack);
      expect(allUnchanged(yield* driftActions(stack))).toBe(true);
      yield* assertEntries(arn, "routes", { "/": "/index.html", "/about": "/about.html" });

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:cloudfront", "live"], timeout: 240_000 },
);

const assertEntries = (store: string, namespace: string, expected: Record<string, string>) =>
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
      while: (error) => error instanceof Error && error.message === "KeyValueStoreStillExists",
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
    }),
  );
