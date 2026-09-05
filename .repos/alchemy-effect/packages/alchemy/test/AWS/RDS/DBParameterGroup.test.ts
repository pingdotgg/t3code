import * as AWS from "@/AWS";
import { DBParameterGroup } from "@/AWS/RDS/DBParameterGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection). Parameter
// groups create and delete fast (well within the 240s budget), so we deploy a
// real group, resolve the provider via the typed `Provider.findProvider(
// DBParameterGroup)` so `list()`'s element type is the exact
// `DBParameterGroup["Attributes"]` shape, call it, and assert the deployed
// group appears in the exhaustively-paginated result.
test.provider("list enumerates the deployed DB parameter group", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const group = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* DBParameterGroup("ListDBParameterGroup", {
          dbParameterGroupName: "alchemy-test-dbpg-list",
          family: "aurora-postgresql16",
          description: "Alchemy list() test parameter group",
        });
      }),
    );

    const provider = yield* Provider.findProvider(DBParameterGroup);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    expect(
      all.some((g) => g.dbParameterGroupName === group.dbParameterGroupName),
    ).toBe(true);

    for (const g of all) {
      expect(typeof g.dbParameterGroupName).toBe("string");
      expect(typeof g.family).toBe("string");
    }

    yield* stack.destroy();
  }),
);
