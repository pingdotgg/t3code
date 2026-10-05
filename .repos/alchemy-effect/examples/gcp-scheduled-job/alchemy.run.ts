import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Admin from "./src/Admin.ts";
import { Nightly } from "./src/Nightly.ts";
import { Orders, Reports } from "./src/resources.ts";
import Summarize from "./src/Summarize.ts";

export default Alchemy.Stack(
  "GcpScheduledJobExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const orders = yield* Orders;
    const reports = yield* Reports;
    const job = yield* Summarize;
    const nightly = yield* Nightly;
    const admin = yield* Admin;

    return {
      url: admin.uri,
      project: job.project,
      jobName: job.name,
      schedulerJobName: nightly.name,
      tableName: orders.name,
      datasetId: orders.datasetId,
      tableId: orders.tableId,
      bucketName: reports.bucketName,
    };
  }),
);
