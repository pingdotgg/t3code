import { expect, it } from "vite-plus/test";
import {
  MERGE_REQUEST_TERMINOLOGY,
  PULL_REQUEST_TERMINOLOGY,
} from "@t3tools/client-runtime/source-control-clients";
import { summarizePullRequestRouting } from "./PullRequestRoutingSettings.logic";

it("preserves environment names while formatting routing permissions", () => {
  for (const terms of [PULL_REQUEST_TERMINOLOGY, MERGE_REQUEST_TERMINOLOGY]) {
    expect(
      summarizePullRequestRouting(
        [
          { label: "PR build machine", permission: "read" },
          { label: "MR deploy machine", permission: "read-write" },
          { label: "Pull request archive", permission: "off" },
        ],
        terms,
      ),
    ).toBe(`MR deploy machine read and act \u00b7 PR build machine read ${terms.shortLabel}s`);
    expect(
      summarizePullRequestRouting([{ label: "PR build machine", permission: "off" }], terms),
    ).toBeNull();
  }
});
