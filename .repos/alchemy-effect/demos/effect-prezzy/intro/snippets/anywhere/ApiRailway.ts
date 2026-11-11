import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Files, FilesRailway } from "./Files.ts";
import { Chat } from "./Hosts.ts";

// #region show
export default Railway.Service(
  "Api",
  Effect.gen(function* () {
    return { main: import.meta.url, project: yield* Chat };
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
  }).pipe(Effect.provide(FilesRailway)),
);
// #endregion show
