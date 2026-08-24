import * as AWS from "@/AWS";
import { KvEntries } from "@/AWS/CloudFront";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

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
});
