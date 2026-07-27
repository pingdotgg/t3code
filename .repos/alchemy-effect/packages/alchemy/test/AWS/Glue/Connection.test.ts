import * as AWS from "@/AWS";
import { Connection } from "@/AWS/Glue";
import * as Test from "@/Test/Alchemy";
import * as glue from "@distilled.cloud/aws/glue";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

const getConnection = (name: string) =>
  glue.getConnection({ Name: name, HidePassword: true }).pipe(
    Effect.map((r) => r.Connection),
    Effect.catchTag("EntityNotFoundException", () => Effect.succeed(undefined)),
  );

test.provider("create, update, delete Glue JDBC connection", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Connection("Warehouse", {
          connectionType: "JDBC",
          description: "warehouse jdbc",
          connectionProperties: {
            JDBC_CONNECTION_URL:
              "jdbc:postgresql://db.example.com:5432/warehouse",
            USERNAME: "glue",
            PASSWORD: Redacted.make("secret"),
          },
          tags: { Environment: "test" },
        });
      }),
    );

    expect(created.connectionName).toBeDefined();
    expect(created.connectionType).toEqual("JDBC");
    expect(created.connectionArn).toContain(
      `:connection/${created.connectionName}`,
    );

    const observed = yield* getConnection(created.connectionName);
    expect(observed?.Name).toEqual(created.connectionName);
    expect(observed?.ConnectionType).toEqual("JDBC");
    expect(observed?.ConnectionProperties?.JDBC_CONNECTION_URL).toEqual(
      "jdbc:postgresql://db.example.com:5432/warehouse",
    );

    const tags = yield* glue.getTags({ ResourceArn: created.connectionArn });
    expect(tags.Tags?.["alchemy::id"]).toBeDefined();
    expect(tags.Tags?.Environment).toEqual("test");

    // update the JDBC URL
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Connection("Warehouse", {
          connectionType: "JDBC",
          description: "warehouse jdbc v2",
          connectionProperties: {
            JDBC_CONNECTION_URL:
              "jdbc:postgresql://db2.example.com:5432/warehouse",
            USERNAME: "glue",
            PASSWORD: Redacted.make("secret"),
          },
          tags: { Environment: "test" },
        });
      }),
    );

    const reobserved = yield* getConnection(created.connectionName);
    expect(reobserved?.ConnectionProperties?.JDBC_CONNECTION_URL).toEqual(
      "jdbc:postgresql://db2.example.com:5432/warehouse",
    );

    yield* stack.destroy();
    const gone = yield* getConnection(created.connectionName);
    expect(gone).toBeUndefined();
  }),
);
