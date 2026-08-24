import * as AWS from "@/AWS";
import { KvRoutesUpdate } from "@/AWS/CloudFront";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

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
});
