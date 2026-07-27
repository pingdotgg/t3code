import * as AWS from "@/AWS";
import { AssetDeployment } from "@/AWS/Website/AssetDeployment.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("list returns [] for the non-listable AssetDeployment", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(AssetDeployment);
    const all = yield* provider.list();
    expect(all).toEqual([]);
  }),
);
