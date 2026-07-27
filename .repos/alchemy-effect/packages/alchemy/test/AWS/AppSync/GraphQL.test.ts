import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { fileURLToPath } from "node:url";

const { test } = Test.make({ providers: AWS.providers() });

const resolverHandlerPath = fileURLToPath(
  new URL("./resolver-handler.ts", import.meta.url),
);

/**
 * The unit-resolver code: forward the field name + args to the Lambda
 * data source and surface the invocation result as the field value.
 */
const LAMBDA_RESOLVER_CODE = `
export function request(ctx) {
  return {
    operation: "Invoke",
    payload: { field: ctx.info.fieldName, args: ctx.args },
  };
}
export function response(ctx) {
  return ctx.result;
}
`;

/** Pipeline step: same Lambda invocation, packaged as an AppSync Function. */
const PIPELINE_STEP_CODE = LAMBDA_RESOLVER_CODE;

/** Pipeline resolver: run the steps and return the last step's result. */
const PIPELINE_RESOLVER_CODE = `
export function request(ctx) {
  return {};
}
export function response(ctx) {
  return ctx.prev.result;
}
`;

const SCHEMA = `
type Query {
  add(a: Int!, b: Int!): Int!
  greet(name: String!): String!
  double(n: Int!): Int!
}
schema { query: Query }
`;

/** Fresh AppSync endpoints/keys propagate within a few seconds. */
const edgePropagationRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential(500).pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(
              Duration.isGreaterThan(duration, Duration.seconds(5))
                ? Duration.seconds(5)
                : duration,
            ),
          ),
        ),
        Schedule.recurs(10),
      ]),
    }),
  );

const graphql = (url: string, apiKey: string, query: string) =>
  HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("x-api-key", apiKey),
      HttpClientRequest.bodyJsonUnsafe({ query }),
    ),
  );

test.provider(
  "GraphQL API over a Lambda data source (unit + pipeline resolvers, api key auth)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.Function("ResolverFn", {
            main: resolverHandlerPath,
            handler: "handler",
            isExternal: true,
            url: false,
          });
          const api = yield* AWS.AppSync.GraphqlApi("E2EApi", {
            schema: SCHEMA,
          });
          const lambdaDS = yield* AWS.AppSync.DataSource("LambdaDS", {
            api,
            type: "AWS_LAMBDA",
            lambdaConfig: { lambdaFunctionArn: fn.functionArn },
          });
          // UNIT resolvers with APPSYNC_JS runtime.
          yield* AWS.AppSync.Resolver("AddResolver", {
            api,
            typeName: "Query",
            fieldName: "add",
            dataSource: lambdaDS,
            code: LAMBDA_RESOLVER_CODE,
          });
          yield* AWS.AppSync.Resolver("GreetResolver", {
            api,
            typeName: "Query",
            fieldName: "greet",
            dataSource: lambdaDS,
            code: LAMBDA_RESOLVER_CODE,
          });
          // PIPELINE resolver running one AppSync Function step.
          const step = yield* AWS.AppSync.Function("InvokeStep", {
            api,
            dataSource: lambdaDS,
            code: PIPELINE_STEP_CODE,
          });
          yield* AWS.AppSync.Resolver("DoubleResolver", {
            api,
            typeName: "Query",
            fieldName: "double",
            kind: "PIPELINE",
            pipelineFunctionIds: [step.functionId],
            code: PIPELINE_RESOLVER_CODE,
          });
          const key = yield* AWS.AppSync.ApiKey("Key", { api });
          return {
            apiId: api.apiId,
            url: api.graphqlUrl,
            apiKey: key.id,
          };
        }),
      );

      const apiKey = Redacted.value(out.apiKey);
      expect(out.url).toContain("appsync-api");
      expect(apiKey).toMatch(/^da2-/);

      // 1. Unit resolver: the result is computed inside the Lambda.
      const add = yield* edgePropagationRetry(
        graphql(out.url, apiKey, "query { add(a: 2, b: 3) }").pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(new Error(`add returned ${response.status}`)),
          ),
          Effect.flatMap((body: any) =>
            body?.data?.add === undefined
              ? Effect.fail(new Error(`no data.add: ${JSON.stringify(body)}`))
              : Effect.succeed(body),
          ),
        ),
      );
      expect((add as any).data.add).toBe(5);

      // 2. Unit resolver with a string result.
      const greet = (yield* graphql(
        out.url,
        apiKey,
        'query { greet(name: "Alchemy") }',
      ).pipe(Effect.flatMap((response) => response.json))) as any;
      expect(greet.data.greet).toBe("Hello, Alchemy! (from Lambda)");

      // 3. Pipeline resolver: the step's Lambda result flows through
      //    ctx.prev.result.
      const double = (yield* graphql(
        out.url,
        apiKey,
        "query { double(n: 21) }",
      ).pipe(Effect.flatMap((response) => response.json))) as any;
      expect(double.data.double).toBe(42);

      // 4. Requests without the api key are rejected.
      const unauthorized = yield* HttpClient.execute(
        HttpClientRequest.post(out.url).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            query: "query { add(a: 1, b: 1) }",
          }),
        ),
      );
      expect(unauthorized.status).toBeGreaterThanOrEqual(401);

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);
