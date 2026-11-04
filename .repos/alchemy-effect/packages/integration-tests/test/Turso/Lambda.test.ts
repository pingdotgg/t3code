import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Turso from "@alchemy.run/turso";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import TursoLambda from "./fixtures/lambda.ts";
import { LambdaDb } from "./fixtures/resources.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Turso.providers(), AWS.providers()),
});

test.provider(
  "Connect + SQL.LibSQL and Drizzle.LibSQL query Turso from a Lambda",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* LambdaDb;
          const fn = yield* TursoLambda;
          return { url: fn.functionUrl };
        }),
      );
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const response = yield* http
        .get(url!)
        .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
      expect(yield* response.json).toEqual({ answer: 42, two: 2 });
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:turso",
      "provider:turso:database",
      "provider:aws",
      "provider:aws:lambda",
      "live",
    ],
    timeout: 300_000,
  },
);
