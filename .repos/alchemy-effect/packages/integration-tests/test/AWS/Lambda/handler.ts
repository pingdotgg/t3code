import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";

const main = import.meta.url;

export class TestFunction extends Lambda.Function<Lambda.Function>()("TestFunction") {}

export const TestFunctionLive = TestFunction.make(
  {
    main,
    functionUrl: true,
  },
  Effect.gen(function* () {
    // Read at init through the runtime ConfigProvider; the env values are
    // plain strings that look like JSON ("true", "3000").
    const flag = yield* Config.option(Config.Boolean("CONFIG_FLAG"));
    const port = yield* Config.option(Config.Number("CONFIG_PORT"));
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = yield* Effect.sync(() => new URL(request.originalUrl).pathname);
        if (pathname === "/readiness") {
          const marker = yield* Effect.sync(() => process.env.READINESS_MARKER);
          return HttpServerResponse.text(marker ?? "missing");
        }
        if (pathname === "/config") {
          return HttpServerResponse.text(
            `${Option.getOrUndefined(flag)} ${Option.getOrUndefined(port)}`,
          );
        }
        return HttpServerResponse.text("Hello, world!");
      }),
    };
  }),
);

export default TestFunctionLive;
