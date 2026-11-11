import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { DatabaseLive } from "./Db.ts";
import { Files } from "./Files.ts";
import { History, HistoryLive } from "./History.ts";
import Room from "./Room.ts";

// #region show
export default Cloudflare.Worker(
  "Chat",
  { main: import.meta.url },
  Effect.gen(function* () {
    const rooms = yield* Room;
    const history = yield* History;
    const files = yield* Files;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, room, file] = request.url.split("/");
        if (route === "join") return yield* rooms.getByName(room!).fetch(request);
        if (route === "upload") {
          yield* files.upload(file!, yield* request.text);
          return HttpServerResponse.empty({ status: 201 });
        }
        return yield* HttpServerResponse.json(yield* history.list(room!));
      }) /*hide*/
        .pipe(Effect.orDie) /*end*/,
    };
  }).pipe(Effect.provide([HistoryLive.pipe(Layer.provide(DatabaseLive))])),
);
// #endregion show
