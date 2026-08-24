import * as AWS from "@/AWS";
import { Keyspace, Type } from "@/AWS/Keyspaces";
import * as Test from "@/Test/Alchemy";
import * as keyspaces from "@distilled.cloud/aws/keyspaces";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getType = (keyspaceName: string, typeName: string) =>
  keyspaces
    .getType({ keyspaceName, typeName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "create, replace on field change, delete Keyspaces type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ksName = "alchemy_type_test_ks";

      // create keyspace + type (generated type name — replacement-safe)
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const keyspace = yield* Keyspace("Ks", { keyspaceName: ksName });
          const address = yield* Type("Address", {
            keyspaceName: keyspace.keyspaceName,
            fields: [
              { name: "street", type: "text" },
              { name: "city", type: "text" },
            ],
          });
          return { address };
        }),
      );

      expect(created.address.keyspaceName).toEqual(ksName);
      expect(created.address.keyspaceArn).toContain(`keyspace/${ksName}`);

      // out-of-band verification
      const observed = yield* getType(ksName, created.address.typeName);
      const fields = new Set(
        (observed?.fieldDefinitions ?? []).map((f) => f.name),
      );
      expect(fields.has("street")).toBe(true);
      expect(fields.has("city")).toBe(true);

      // UDTs are immutable — adding a field replaces the type
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const keyspace = yield* Keyspace("Ks", { keyspaceName: ksName });
          const address = yield* Type("Address", {
            keyspaceName: keyspace.keyspaceName,
            fields: [
              { name: "street", type: "text" },
              { name: "city", type: "text" },
              { name: "zip", type: "text" },
            ],
          });
          return { address };
        }),
      );

      expect(replaced.address.typeName).not.toEqual(created.address.typeName);
      const reobserved = yield* getType(ksName, replaced.address.typeName);
      const reFields = new Set(
        (reobserved?.fieldDefinitions ?? []).map((f) => f.name),
      );
      expect(reFields.has("zip")).toBe(true);
      // the replaced (old) type is gone
      const old = yield* getType(ksName, created.address.typeName);
      expect(old).toBeUndefined();

      // delete
      yield* stack.destroy();
      const gone = yield* getType(ksName, replaced.address.typeName);
      expect(gone).toBeUndefined();
    }),
  { timeout: 240_000 },
);
