import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const main = import.meta.url;

export class TestFunction extends Lambda.Function<Lambda.Function>()(
  "TestFunction",
) {}

export const TestFunctionLive = TestFunction.make(
  {
    main,
    functionUrl: true,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = yield* Effect.sync(
          () => new URL(request.originalUrl).pathname,
        );
        if (pathname === "/readiness") {
          const marker = yield* Effect.sync(() => process.env.READINESS_MARKER);
          return HttpServerResponse.text(marker ?? "missing");
        }
        return HttpServerResponse.text("Hello, world!");
      }),
    };
  }),
);

export default TestFunctionLive;
