import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");
const targetMain = path.resolve(import.meta.dirname, "timeout-handler.ts");

export class LambdaBindingsTestFunction extends Lambda.Function<Lambda.Function>()(
  "LambdaBindingsTestFunction",
) {}

export default LambdaBindingsTestFunction.make(
  {
    main,
    url: true,
    // Resolve distilled from `src/*.ts` (the `bun` export condition — same
    // as vitest) so distilled source changes are test-visible in the
    // deployed bundle without a `lib/` rebuild.
    build: {
      resolve: { conditionNames: ["bun", "import", "module", "default"] },
    },
  },
  Effect.gen(function* () {
    const target = yield* Lambda.Function("BindingsTarget", {
      main: targetMain,
      handler: "handler",
      isExternal: true,
      url: false,
    });

    const invokeFunction = yield* Lambda.InvokeFunction(target);
    const invokeWithResponseStream =
      yield* Lambda.InvokeWithResponseStream(target);
    const getFunction = yield* Lambda.GetFunction(target);
    const getAccountSettings = yield* Lambda.GetAccountSettings();
    const listFunctions = yield* Lambda.ListFunctions();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (pathname === "/invoke") {
          const response = yield* invokeFunction({});
          return yield* HttpServerResponse.json({
            statusCode: response.StatusCode,
            executedVersion: response.ExecutedVersion,
          });
        }

        if (pathname === "/invoke-stream") {
          const response = yield* invokeWithResponseStream({});
          const events = response.EventStream
            ? Array.from(yield* Stream.runCollect(response.EventStream))
            : [];
          const decoder = new TextDecoder();
          const decodeChunk = (chunk: unknown): string => {
            const value = Redacted.isRedacted(chunk)
              ? Redacted.value(chunk)
              : chunk;
            if (value instanceof Uint8Array) return decoder.decode(value);
            if (typeof value === "string") return value;
            return "";
          };
          const payload = events
            .map((event) =>
              "PayloadChunk" in event && event.PayloadChunk
                ? decodeChunk(event.PayloadChunk.Payload)
                : "",
            )
            .join("");
          const complete = events.some((event) => "InvokeComplete" in event);
          return yield* HttpServerResponse.json({
            statusCode: response.StatusCode,
            payload,
            complete,
            // debug: surface the raw event shapes so assertion failures are
            // diagnosable from the test output
            eventShapes: events.map((event) =>
              Object.entries(event).map(
                ([key, value]) =>
                  `${key}:${value === undefined ? "undefined" : `[${Object.keys(value ?? {}).join(",")}]`}`,
              ),
            ),
          });
        }

        if (pathname === "/get-function") {
          const response = yield* getFunction();
          return yield* HttpServerResponse.json({
            functionName: response.Configuration?.FunctionName,
            state: response.Configuration?.State,
          });
        }

        if (pathname === "/account-settings") {
          const response = yield* getAccountSettings();
          return yield* HttpServerResponse.json({
            concurrentExecutions: response.AccountLimit?.ConcurrentExecutions,
          });
        }

        if (pathname === "/list-functions") {
          const response = yield* listFunctions({ MaxItems: 5 });
          return yield* HttpServerResponse.json({
            count: response.Functions?.length ?? 0,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.InvokeFunctionHttp,
        Lambda.InvokeWithResponseStreamHttp,
        Lambda.GetFunctionHttp,
        Lambda.GetAccountSettingsHttp,
        Lambda.ListFunctionsHttp,
      ),
    ),
  ),
);
