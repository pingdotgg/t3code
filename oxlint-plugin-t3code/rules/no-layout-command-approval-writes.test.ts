import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-layout-command-approval-writes");

describe("t3code/no-layout-command-approval-writes", () => {
  rule.valid(
    "allows reading approvals",
    `import * as LayoutCommandApprovals from "../workspace/LayoutCommandApprovals.ts";
     export const approvals = LayoutCommandApprovals.LayoutCommandApprovals;`,
  );

  rule.invalid(
    "reports an MCP toolkit importing the write side",
    `import * as LayoutCommandApprovalWrites from "../../../workspace/LayoutCommandApprovalWrites.ts";
     export const writes = LayoutCommandApprovalWrites.LayoutCommandApprovalWrites;`,
  );

  rule.invalid(
    "reports a type-only import, which would still name the service to yield",
    `import type { LayoutCommandApprovalWrites } from "./LayoutCommandApprovalWrites.ts";
     export type Writes = LayoutCommandApprovalWrites;`,
  );

  rule.invalid(
    "reports a re-export",
    `export * from "./workspace/LayoutCommandApprovalWrites.ts";`,
  );

  rule.invalid(
    "reports a dynamic import",
    `export const load = () => import("./workspace/LayoutCommandApprovalWrites.ts");`,
  );
});
