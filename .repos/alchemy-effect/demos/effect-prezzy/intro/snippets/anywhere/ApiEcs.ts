import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Files, FilesS3 } from "./Files.ts";
import { Cluster } from "./Hosts.ts";

// #region show
export default AWS.ECS.Service(
  "Api",
  Effect.gen(function* () {
    return { main: import.meta.url, cluster: yield* Cluster, port: 3000 };
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
  }).pipe(Effect.provide(FilesS3)),
);
// #endregion show
