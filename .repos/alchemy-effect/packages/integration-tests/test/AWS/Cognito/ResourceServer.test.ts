import * as AWS from "@alchemy.run/aws";
import { ResourceServer, UserPool } from "@alchemy.run/aws/Cognito";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, mutate scopes, delete resource server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("RSTestPool", {});
          const server = yield* ResourceServer("Api", {
            userPoolId: pool.userPoolId,
            identifier: "https://api.alchemy-test.example.com",
            name: "Test API",
            scopes: [{ scopeName: "read", scopeDescription: "Read access" }],
          });
          return { pool, server };
        }),
      );

      expect(outputs.server.identifier).toBe("https://api.alchemy-test.example.com");
      expect(outputs.server.name).toBe("Test API");

      // out-of-band verification via distilled
      const created = yield* cip.describeResourceServer({
        UserPoolId: outputs.pool.userPoolId,
        Identifier: outputs.server.identifier,
      });
      expect(created.ResourceServer?.Name).toBe("Test API");
      expect(created.ResourceServer?.Scopes).toHaveLength(1);

      // scopes and name mutate in place
      yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("RSTestPool", {});
          const server = yield* ResourceServer("Api", {
            userPoolId: pool.userPoolId,
            identifier: "https://api.alchemy-test.example.com",
            name: "Renamed API",
            scopes: [
              { scopeName: "read", scopeDescription: "Read access" },
              { scopeName: "write", scopeDescription: "Write access" },
            ],
          });
          return { pool, server };
        }),
      );
      const afterUpdate = yield* cip.describeResourceServer({
        UserPoolId: outputs.pool.userPoolId,
        Identifier: outputs.server.identifier,
      });
      expect(afterUpdate.ResourceServer?.Name).toBe("Renamed API");
      expect(afterUpdate.ResourceServer?.Scopes).toHaveLength(2);

      yield* stack.destroy();
      const gone = yield* cip
        .describeResourceServer({
          UserPoolId: outputs.pool.userPoolId,
          Identifier: outputs.server.identifier,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:aws", "provider:aws:cognito", "live"], timeout: 120_000 },
);
