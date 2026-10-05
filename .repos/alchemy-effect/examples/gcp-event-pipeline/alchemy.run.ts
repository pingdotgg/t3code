import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Drain from "./src/Drain.ts";
import Ingest from "./src/Ingest.ts";
import { EventsTable, Inbox } from "./src/resources.ts";

export default Alchemy.Stack(
  "GcpEventPipelineExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const inbox = yield* Inbox;
    const table = yield* EventsTable;
    const ingest = yield* Ingest;
    const drain = yield* Drain;

    return {
      url: ingest.uri,
      jobName: drain.name,
      subscriptionId: inbox.subscriptionId,
      tableId: table.tableId,
    };
  }),
);
