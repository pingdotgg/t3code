import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import path from "pathe";
import { app } from "../../../../Workflows/conformance/app.ts";
import { TestWorkflows } from "./host.ts";
import { JournalLive } from "./journal.ts";

const main = path.resolve(import.meta.dirname, "caller.ts");

/** A plain Lambda function that serves the conformance app over TestWorkflows. */
export class WorkflowCaller extends Lambda.Function<WorkflowCaller>()("WorkflowCaller") {}

export default WorkflowCaller.make(
  { main, functionUrl: true, timeout: Duration.seconds(60) },
  app.pipe(
    Effect.provide(Layer.mergeAll(Lambda.DurableFunctionEngine(TestWorkflows), JournalLive)),
  ),
);
