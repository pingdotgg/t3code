import * as AWS from "@/AWS";
import { DBParameterGroup } from "@/AWS/RDS/DBParameterGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

/** The parameters RDS reports as user-set, which is what the resource owns. */
const userParameters = Effect.fn(function* (name: string) {
  const pages = yield* rds.describeDBParameters
    .pages({ DBParameterGroupName: name, Source: "user" })
    .pipe(Stream.runCollect);
  return Object.fromEntries(
    Array.from(pages)
      .flatMap((page) => page.Parameters ?? [])
      .flatMap((p) =>
        p.ParameterName && p.ParameterValue !== undefined
          ? [[p.ParameterName, p.ParameterValue] as const]
          : [],
      ),
  );
});

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

// Parameters reconcile in place: a redeploy writes changed values and resets
// keys the props dropped, both diffed against live `Source=user` state rather
// than the prior props.
test.provider("parameters are written, updated and reset", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-dbpg-params";
    const deploy = (parameters: Record<string, string>) =>
      stack.deploy(
        Effect.gen(function* () {
          return yield* DBParameterGroup("ParamsDBParameterGroup", {
            dbParameterGroupName: name,
            family: "mysql8.4",
            description: "Alchemy parameters test parameter group",
            parameters,
          });
        }),
      );

    const created = yield* deploy({
      time_zone: "Australia/Sydney",
      max_connections: "150",
    });
    expect(created.parameters.time_zone).toBe("Australia/Sydney");

    const afterCreate = yield* userParameters(name);
    expect(afterCreate.time_zone).toBe("Australia/Sydney");
    expect(afterCreate.max_connections).toBe("150");

    // time_zone changes; max_connections is dropped and must go back to the
    // engine default, which removes it from Source=user entirely.
    yield* deploy({ time_zone: "UTC" });

    const afterUpdate = yield* userParameters(name);
    expect(afterUpdate.time_zone).toBe("UTC");
    expect(afterUpdate.max_connections).toBeUndefined();

    yield* stack.destroy();
  }),
);
