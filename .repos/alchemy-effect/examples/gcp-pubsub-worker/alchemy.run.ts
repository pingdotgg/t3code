import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Jobs, Results } from "./src/resources.ts";
import Worker from "./src/Worker.ts";

export default Alchemy.Stack(
  "GcpPubSubWorkerExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    const results = yield* Results;
    const api = yield* Api;
    const worker = yield* Worker;

    return {
      url: api.uri,
      topicName: jobs.name,
      databaseName: results.name,
      workerPoolName: worker.name,
    };
  }),
);
