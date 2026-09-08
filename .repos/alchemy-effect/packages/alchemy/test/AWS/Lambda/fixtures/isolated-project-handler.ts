import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { isolatedProject } from "../../../IsolatedProject.ts";

/**
 * The isolated consumer project this function is bundled from (see
 * `test/IsolatedProject.ts`): `main` lives outside the repository, so the
 * bundle `cwd` resolves none of alchemy's dependencies and the Lambda
 * bootstrap's own imports (`@distilled.cloud/aws/*`,
 * `@effect/platform-node`, …) must be anchored by the bundler.
 */
export const project = isolatedProject("lambda-function", import.meta.filename);

export const BODY = "hello from isolated project";

/**
 * Minimal `AWS.Lambda.Function` (zip, Node runtime) with a function URL.
 * A 200 from the URL proves the generated bootstrap loaded — with its
 * imports left external the runtime fails at init with `Cannot find
 * package` and the URL answers 5xx.
 */
export class IsolatedProjectFunction extends Lambda.Function<Lambda.Function>()(
  "LambdaIsolatedProjectFunction",
) {}

export default IsolatedProjectFunction.make(
  { main: project.main, functionUrl: true },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text(BODY);
      }),
    };
  }),
);
