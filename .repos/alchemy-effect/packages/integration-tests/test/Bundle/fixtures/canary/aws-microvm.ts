import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** A Node MicroVM program that reaches the AWS package through `import * as AWS`. */
export class CanaryMicrovm extends AWS.Lambda.MicrovmImage<CanaryMicrovm>()("CanaryMicrovm") {}

/** Throws so `/trace` can show how a stack trace reads from the minified bundle. */
function canaryThrows(): never {
  throw new Error("canary");
}

export default CanaryMicrovm.make(
  {
    main: import.meta.filename,
    resources: [{ minimumMemoryInMiB: 512 }],
    cpuConfigurations: [{ architecture: "ARM_64" }],
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://microvm");
        if (url.pathname === "/trace") {
          const stack = yield* Effect.try({
            try: canaryThrows,
            catch: (error) => String((error as { stack?: unknown }).stack),
          }).pipe(Effect.flip);
          return yield* HttpServerResponse.json({ stack });
        }
        return yield* HttpServerResponse.json({ path: url.pathname });
      }),
    };
  }),
);
