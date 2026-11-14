import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Files, FilesGCS } from "./Files.ts";

// #region show
export default GCP.Run.Service(
  "Api",
  Effect.gen(function* () {
    return { main: import.meta.url };
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
  }).pipe(Effect.provide(FilesGCS)),
);
// #endregion show
