import * as AppSync from "@/AWS/AppSync";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

const SCHEMA = `
type Query {
  add(a: Int!, b: Int!): Int!
  greeting: String
}
schema { query: Query }
`;

/** NONE data source: compute the sum locally in the resolver. */
const ADD_RESOLVER = `
export function request(ctx) {
  return { payload: ctx.args.a + ctx.args.b };
}
export function response(ctx) {
  return ctx.result;
}
`;

/** Reads the API's environment variables (ctx.env) at resolve time. */
const GREETING_RESOLVER = `
export function request(ctx) {
  return { payload: null };
}
export function response(ctx) {
  return ctx.env.GREETING;
}
`;

export class AppSyncBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "AppSyncBindingsFunction",
) {}

export default AppSyncBindingsFunction.make(
  {
    main,
    url: true,
    // The GraphQL round-trip fans out a signed HTTP call; AWS's 3s default
    // intermittently times out on a cold start.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const api = yield* AppSync.GraphqlApi("BindingsApi", {
      authenticationType: "AWS_IAM",
      schema: SCHEMA,
      environmentVariables: { GREETING: "hello from ctx.env" },
    });
    const local = yield* AppSync.DataSource("LocalDS", {
      api,
      type: "NONE",
    });
    yield* AppSync.Resolver("AddResolver", {
      api,
      typeName: "Query",
      fieldName: "add",
      dataSource: local,
      code: ADD_RESOLVER,
    });
    yield* AppSync.Resolver("GreetingResolver", {
      api,
      typeName: "Query",
      fieldName: "greeting",
      dataSource: local,
      code: GREETING_RESOLVER,
    });

    const graphql = yield* AppSync.GraphQL(api);
    const flushCache = yield* AppSync.FlushApiCache(api);
    const getSchema = yield* AppSync.GetIntrospectionSchema(api);
    const evaluateCode = yield* AppSync.EvaluateCode();
    const evaluateTemplate = yield* AppSync.EvaluateMappingTemplate();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "POST" && pathname === "/graphql") {
          const body = (yield* request.json) as unknown as {
            query: string;
            variables?: Record<string, unknown>;
          };
          const result = yield* graphql.execute({
            query: body.query,
            variables: body.variables,
          });
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/flush") {
          // Surface the typed outcome tag to the test — the API has no
          // cache provisioned, so the expected result is the typed
          // NotFoundException (which proves the call executed with the
          // granted appsync:FlushApiCache).
          const outcome = yield* Effect.result(flushCache());
          return yield* HttpServerResponse.json(
            Result.isSuccess(outcome)
              ? { flushed: true }
              : {
                  flushed: false,
                  reason: outcome.failure._tag,
                  message: String(
                    (outcome.failure as { message?: string }).message ?? "",
                  ),
                },
          );
        }

        if (request.method === "GET" && pathname === "/schema") {
          // The introspected schema arrives as a streaming body.
          const response = yield* getSchema({ format: "SDL" });
          const sdl = yield* Stream.mkString(
            Stream.decodeText(response.schema!),
          );
          return yield* HttpServerResponse.json({ sdl });
        }

        if (request.method === "POST" && pathname === "/evaluate") {
          // Evaluate the add resolver's request function against a mock
          // context — evaluation errors surface on `result.error`.
          const result = yield* evaluateCode({
            runtime: AppSync.APPSYNC_JS,
            code: ADD_RESOLVER,
            context: JSON.stringify({ arguments: { a: 2, b: 3 } }),
            function: "request",
          });
          return yield* HttpServerResponse.json({
            evaluationResult: result.evaluationResult,
            error: result.error,
          });
        }

        if (request.method === "POST" && pathname === "/evaluate-template") {
          // Render a VTL template against a mock context — template
          // evaluation errors surface on `result.error`.
          const result = yield* evaluateTemplate({
            // VTL only allows arithmetic inside #set directives.
            template: [
              `#set($sum = $ctx.args.a + $ctx.args.b)`,
              `{ "sum": $util.toJson($sum) }`,
            ].join("\n"),
            context: JSON.stringify({ arguments: { a: 2, b: 3 } }),
          });
          return yield* HttpServerResponse.json({
            evaluationResult: result.evaluationResult,
            error: result.error,
          });
        }

        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AppSync.GraphQLHttp,
        AppSync.FlushApiCacheHttp,
        AppSync.GetIntrospectionSchemaHttp,
        AppSync.EvaluateCodeHttp,
        AppSync.EvaluateMappingTemplateHttp,
      ),
    ),
  ),
);
