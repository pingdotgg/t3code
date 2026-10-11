import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Monitor from "./src/Monitor.ts";
import { Heartbeats } from "./src/resources.ts";

export default Alchemy.Stack(
  "GcpCronExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const table = yield* Heartbeats;
    const monitor = yield* Monitor;

    return {
      url: monitor.uri,
      project: monitor.project,
      location: monitor.location,
      tableName: table.name,
      datasetId: table.datasetId,
      tableId: table.tableId,
    };
  }),
);
