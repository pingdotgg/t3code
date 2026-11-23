import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { WorkflowToolkit } from "./tools.ts";

it("keeps exact wait names and store keys", () => {
  const decode = Schema.decodeUnknownSync(WorkflowToolkit.tools.t3_workflow.parametersSchema);
  expect(decode({ action: "signal", runId: "run-1", wait: "review " }).wait).toBe("review ");
  expect(() => decode({ action: "signal", runId: "run-1", wait: " " })).toThrow();
  expect(decode({ action: "store", key: "team " }).key).toBe("team ");
  expect(() => decode({ action: "store_set", key: " ", value: 1 })).toThrow();
});
