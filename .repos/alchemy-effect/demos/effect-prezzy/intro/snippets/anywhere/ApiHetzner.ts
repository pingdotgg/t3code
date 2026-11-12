import * as Hetzner from "@alchemy.run/hetzner";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Files, FilesVolume } from "./Files.ts";
import { Box } from "./Hosts.ts";

// #region show
export default Hetzner.Service(
  "Api",
  Effect.gen(function* () {
    return { main: import.meta.url, server: yield* Box, port: 3000 };
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
  }).pipe(Effect.provide(FilesVolume)),
);
// #endregion show
