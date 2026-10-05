import { Function } from "@/Neon/Function";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { project } from "./function-form-resources.ts";
export default Function(
  "Constructor",
  Effect.gen(function* () {
    return { project: yield* project, main: import.meta.url };
  }),
  Effect.succeed({
    fetch: Effect.succeed(HttpServerResponse.text("constructor")),
  }),
);
