import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as appsync from "@distilled.cloud/aws/appsync";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";

const { test } = Test.make({ providers: AWS.providers() });

const authorizerPath = fileURLToPath(
  new URL("./authorizer-handler.ts", import.meta.url),
);

class ApiStillExists extends Data.TaggedError("ApiStillExists")<{
  readonly apiId: string;
}> {}

/** Poll until `getGraphqlApi` returns the typed NotFoundException. */
const assertApiDeleted = (apiId: string) =>
  appsync.getGraphqlApi({ apiId }).pipe(
    Effect.flatMap(() => Effect.fail(new ApiStillExists({ apiId }))),
    Effect.retry({
      while: (e) => e._tag === "ApiStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );

const SCHEMA_V1 = `
type Query {
  hello: String
}
schema { query: Query }
`;

const SCHEMA_V2 = `
type Query {
  hello: String
  version: Int
}
schema { query: Query }
`;

test.provider(
  "create, update, delete GraphQL API with schema and api key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployApi = (schema: string, xray: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const api = yield* AWS.AppSync.GraphqlApi("LifecycleApi", {
              schema,
              xrayEnabled: xray,
              queryDepthLimit: xray ? 5 : undefined,
              environmentVariables: xray
                ? { STAGE: "updated", EXTRA: "1" }
                : { STAGE: "initial" },
            });
            const key = yield* AWS.AppSync.ApiKey("Key", {
              api,
              description: "test key",
            });
            return {
              apiId: api.apiId,
              apiArn: api.apiArn,
              name: api.name,
              graphqlUrl: api.graphqlUrl,
              authenticationType: api.authenticationType,
              keyId: key.id,
            };
          }),
        );

      const out = yield* deployApi(SCHEMA_V1, false);

      expect(out.apiId).toBeTruthy();
      expect(out.graphqlUrl).toContain("appsync-api");
      expect(out.authenticationType).toBe("API_KEY");
      expect(Redacted.value(out.keyId)).toMatch(/^da2-/);

      // Out-of-band verification via distilled.
      const remote = yield* appsync.getGraphqlApi({ apiId: out.apiId });
      expect(remote.graphqlApi?.name).toBe(out.name);
      // Internal Alchemy tags brand the API.
      expect(Object.keys(remote.graphqlApi?.tags ?? {}).length).toBeGreaterThan(
        0,
      );

      // Schema applied and settled.
      const schemaStatus = yield* appsync.getSchemaCreationStatus({
        apiId: out.apiId,
      });
      expect(["SUCCESS", "ACTIVE"]).toContain(schemaStatus.status);

      // Environment variables applied (ctx.env in resolver code).
      const envVars = yield* appsync.getGraphqlApiEnvironmentVariables({
        apiId: out.apiId,
      });
      expect(envVars.environmentVariables).toEqual({ STAGE: "initial" });

      // The API key is registered on the API.
      const keyId = Redacted.value(out.keyId);
      const keys = yield* appsync.listApiKeys({ apiId: out.apiId });
      expect(keys.apiKeys?.map((k) => k.id)).toContain(keyId);
      expect(keys.apiKeys?.find((k) => k.id === keyId)?.description).toBe(
        "test key",
      );

      // Update in place: schema v2 + xray + query depth limit.
      const updated = yield* deployApi(SCHEMA_V2, true);
      expect(updated.apiId).toBe(out.apiId);
      expect(Redacted.value(updated.keyId)).toBe(keyId);

      const afterUpdate = yield* appsync.getGraphqlApi({ apiId: out.apiId });
      expect(afterUpdate.graphqlApi?.xrayEnabled).toBe(true);
      expect(afterUpdate.graphqlApi?.queryDepthLimit).toBe(5);

      // The environment-variable map is replaced wholesale on update.
      const envVarsAfter = yield* appsync.getGraphqlApiEnvironmentVariables({
        apiId: out.apiId,
      });
      expect(envVarsAfter.environmentVariables).toEqual({
        STAGE: "updated",
        EXTRA: "1",
      });

      yield* stack.destroy();
      yield* assertApiDeleted(out.apiId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "authentication modes: AWS_LAMBDA primary with API_KEY + Cognito additional",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const authorizer = yield* AWS.Lambda.Function("Authorizer", {
            main: authorizerPath,
            handler: "handler",
            isExternal: true,
            url: false,
          });
          const pool = yield* AWS.Cognito.UserPool("AuthPool", {});
          const api = yield* AWS.AppSync.GraphqlApi("AuthApi", {
            authenticationType: "AWS_LAMBDA",
            lambdaAuthorizerConfig: {
              authorizerUri: authorizer.functionArn,
              // Duration.Input prop — sent to AWS as whole seconds.
              authorizerResultTtl: "10 minutes",
            },
            additionalAuthenticationProviders: [
              { authenticationType: "API_KEY" },
              {
                authenticationType: "AMAZON_COGNITO_USER_POOLS",
                userPoolConfig: { userPoolId: pool.userPoolId },
              },
            ],
            schema: SCHEMA_V1,
          });
          yield* AWS.Lambda.Permission("AppSyncInvokeAuthorizer", {
            functionName: authorizer.functionName,
            principal: "appsync.amazonaws.com",
            action: "lambda:InvokeFunction",
            sourceArn: api.apiArn,
          });
          return {
            apiId: api.apiId,
            authenticationType: api.authenticationType,
            authorizerArn: authorizer.functionArn,
          };
        }),
      );

      expect(out.authenticationType).toBe("AWS_LAMBDA");

      const remote = yield* appsync.getGraphqlApi({ apiId: out.apiId });
      expect(remote.graphqlApi?.authenticationType).toBe("AWS_LAMBDA");
      expect(remote.graphqlApi?.lambdaAuthorizerConfig?.authorizerUri).toBe(
        out.authorizerArn,
      );
      expect(
        remote.graphqlApi?.lambdaAuthorizerConfig?.authorizerResultTtlInSeconds,
      ).toBe(600);
      expect(
        remote.graphqlApi?.additionalAuthenticationProviders
          ?.map((p) => p.authenticationType)
          .sort(),
      ).toEqual(["AMAZON_COGNITO_USER_POOLS", "API_KEY"].sort());

      yield* stack.destroy();
      yield* assertApiDeleted(out.apiId);
    }),
  { timeout: 240_000 },
);

// ApiCache instances bill hourly and take ~10-20 minutes to provision —
// props are fully implemented but the live path is gated.
test.provider.skipIf(!process.env.AWS_TEST_APPSYNC_CACHE)(
  "api cache lifecycle (hourly billing — gated)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.AppSync.GraphqlApi("CachedApi", {
            schema: SCHEMA_V1,
            cache: {
              type: "SMALL",
              behavior: "FULL_REQUEST_CACHING",
              ttl: "60 seconds",
            },
          });
          return { apiId: api.apiId };
        }),
      );

      // Cache exists (status may still be CREATING — we don't wait).
      const cache = yield* appsync.getApiCache({ apiId: out.apiId });
      expect(cache.apiCache?.apiCachingBehavior).toBe("FULL_REQUEST_CACHING");
      expect(cache.apiCache?.ttl).toBe(60);

      yield* stack.destroy();
      yield* assertApiDeleted(out.apiId);
    }),
  { timeout: 240_000 },
);
