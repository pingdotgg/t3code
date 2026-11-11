import * as Neon from "@alchemy.run/neon";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Files, FilesNeon } from "./Files.ts";
import { Main } from "./Hosts.ts";

// #region show
export default Neon.Function(
  "Api",
  Effect.gen(function* () {
    return { main: import.meta.url, branch: yield* Main };
  }),
  Effect.gen(function* () {
    const files = yield* Files;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        yield* files.upload(request.url, yield* request.text);
        return HttpServerResponse.empty({ status: 201 });
      }) /*hide*/
        .pipe(Effect.orDie) /*end*/,
    };
  }).pipe(Effect.provide(FilesNeon)),
);
// #endregion show
