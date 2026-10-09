import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import Indexer from "./src/Indexer.ts";
import { Files, Uploads } from "./src/resources.ts";

export default Alchemy.Stack(
  "GcpStorageUploadsExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const bucket = yield* Uploads;
    const database = yield* Files;
    const api = yield* Api;
    const indexer = yield* Indexer;

    return {
      url: api.uri,
      indexerUrl: indexer.uri,
      location: api.location,
      bucketName: bucket.bucketName,
      databaseName: database.name,
    };
  }),
);
