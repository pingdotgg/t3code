import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const main = import.meta.filename;

export class TestFunction extends Lambda.Function<Lambda.Function>()(
  "TestFunction",
  {
    main,
    url: true,
  },
) {}

export const TestFunctionLive = TestFunction.make(
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello, world!");
      }),
    };
  }),
);

export default TestFunctionLive;
