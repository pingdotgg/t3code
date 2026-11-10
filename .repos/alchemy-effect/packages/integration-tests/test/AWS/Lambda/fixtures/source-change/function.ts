// Package import (not the @/ alias): the test bundles a temp copy of this
// file from packages/alchemy/.tmp, where the alias does not resolve.
import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export class SourceChangeFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "SourceChangeFunction",
) {}

export const SourceChangeFunctionLive = SourceChangeFunction.make(
  {
    main: import.meta.url,
    functionUrl: false,
    build: {
      external: (moduleId) => moduleId.endsWith("dependency.ts"),
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const loadDependency = yield* Effect.sync(
          () => process.env.LOAD_SOURCE_CHANGE_DEPENDENCY === "true",
        );
        if (loadDependency) {
          yield* Effect.tryPromise(() => import("./dependency.ts")).pipe(Effect.orDie);
        }
        return HttpServerResponse.text("source-v1");
      }),
    };
  }),
);

export default SourceChangeFunctionLive;
