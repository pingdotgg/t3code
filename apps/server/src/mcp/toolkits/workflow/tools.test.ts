import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { WorkflowToolkit } from "./tools.ts";

it("signal keeps a wait's exact name", () => {
  const decode = Schema.decodeUnknownSync(WorkflowToolkit.tools.t3_workflow.parametersSchema);
  expect(decode({ action: "signal", runId: "run-1", wait: "review " }).wait).toBe("review ");
  expect(() => decode({ action: "signal", runId: "run-1", wait: " " })).toThrow();
});
