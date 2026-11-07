import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import path from "pathe";
import { workflows, WorkflowsLive } from "../../../../Workflows/conformance/workflows.ts";
import { JournalLive } from "./journal.ts";

const main = path.resolve(import.meta.dirname, "host.ts");

/** A Lambda durable function that runs the conformance workflows. */
export class TestWorkflows extends Lambda.WorkflowFunction<TestWorkflows>()("TestWorkflows", {
  workflows,
}) {}

export default TestWorkflows.make(
  {
    main,
    executionTimeout: Duration.hours(1),
    retentionPeriod: "1 day",
    timeout: Duration.seconds(60),
    // Runs start on the alias, not `$LATEST`.
    alias: "live",
  },
  WorkflowsLive.pipe(Layer.provide(JournalLive)),
);
