import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as appsync from "@distilled.cloud/aws/appsync";
import * as iam from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const SCHEMA = `
type Query {
  hello: String
}
schema { query: Query }
`;

test.provider(
  "NONE and DynamoDB data sources (auto-created service role)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const api = yield* AWS.AppSync.GraphqlApi("DSApi", {
              schema: SCHEMA,
            });
            const none = yield* AWS.AppSync.DataSource("LocalDS", {
              api,
              type: "NONE",
              description,
            });
            const table = yield* AWS.DynamoDB.Table("DSTable", {
              partitionKey: "pk",
              attributes: { pk: "S" },
              billingMode: "PAY_PER_REQUEST",
            });
            const ddb = yield* AWS.AppSync.DataSource("TableDS", {
              api,
              type: "AMAZON_DYNAMODB",
              dynamodbConfig: { tableName: table.tableName },
            });
            return {
              apiId: api.apiId,
              noneName: none.name,
              noneDescription: description,
              ddbName: ddb.name,
              ddbRoleName: ddb.roleName,
              ddbServiceRoleArn: ddb.serviceRoleArn,
              tableName: table.tableName,
              tableArn: table.tableArn,
            };
          }),
        );

      const out = yield* deploy("v1");

      // Data source names satisfy AppSync's [_A-Za-z][_0-9A-Za-z]* rule.
      expect(out.noneName).toMatch(/^[_A-Za-z][_0-9A-Za-z]*$/);
      expect(out.ddbName).toMatch(/^[_A-Za-z][_0-9A-Za-z]*$/);

      // Out-of-band verification via distilled.
      const none = yield* appsync.getDataSource({
        apiId: out.apiId,
        name: out.noneName,
      });
      expect(none.dataSource?.type).toBe("NONE");
      expect(none.dataSource?.description).toBe("v1");

      const ddb = yield* appsync.getDataSource({
        apiId: out.apiId,
        name: out.ddbName,
      });
      expect(ddb.dataSource?.type).toBe("AMAZON_DYNAMODB");
      expect(ddb.dataSource?.dynamodbConfig?.tableName).toBe(out.tableName);
      expect(ddb.dataSource?.serviceRoleArn).toBe(out.ddbServiceRoleArn);

      // The auto-created role trusts appsync.amazonaws.com and grants
      // least-privilege access to the table.
      expect(out.ddbRoleName).toBeTruthy();
      const role = yield* iam.getRole({ RoleName: out.ddbRoleName! });
      expect(
        decodeURIComponent(role.Role.AssumeRolePolicyDocument ?? ""),
      ).toContain("appsync.amazonaws.com");
      const policy = yield* iam.getRolePolicy({
        RoleName: out.ddbRoleName!,
        PolicyName: `${out.ddbRoleName}-policy`,
      });
      const policyDocument = decodeURIComponent(policy.PolicyDocument);
      expect(policyDocument).toContain(out.tableArn);
      expect(policyDocument).toContain("dynamodb:Query");

      // Update the NONE data source description in place (same name).
      const updated = yield* deploy("v2");
      expect(updated.noneName).toBe(out.noneName);
      const afterUpdate = yield* appsync.getDataSource({
        apiId: out.apiId,
        name: out.noneName,
      });
      expect(afterUpdate.dataSource?.description).toBe("v2");

      yield* stack.destroy();

      // Both the data source's API and the managed role are gone.
      const roleGone = yield* iam.getRole({ RoleName: out.ddbRoleName! }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NoSuchEntityException", () => Effect.succeed(true)),
      );
      expect(roleGone).toBe(true);
      const apiGone = yield* appsync.getGraphqlApi({ apiId: out.apiId }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
      );
      expect(apiGone).toBe(true);
    }),
  { timeout: 240_000 },
);
