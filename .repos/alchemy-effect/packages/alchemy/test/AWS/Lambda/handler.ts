import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const main = import.meta.url;

export class TestFunction extends Lambda.Function<Lambda.Function>()(
  "TestFunction",
) {}

export const TestFunctionLive = TestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello, world!");
      }),
    };
  }),
);

export default TestFunctionLive;
