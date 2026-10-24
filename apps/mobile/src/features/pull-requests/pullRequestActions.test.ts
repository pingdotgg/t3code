import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { describe, expect, it } from "vite-plus/test";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  mergeSummary,
  mergeUnavailableReason,
  pullRequestActionLabel,
  ALL_PR_ACTIONS,
} from "./pullRequestActions";

const GITHUB = sourceControlClients.get("github").changeRequest;
const GITLAB = sourceControlClients.get("gitlab").changeRequest;

type Detail = Parameters<typeof allowedMergeMethods>[0];

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    autoMergeEnabled: false,
    capabilities: {
      actions: ALL_PR_ACTIONS,
      mergeMethods: ["merge", "squash", "rebase"],
      updateMethods: ["merge", "rebase"],
    },
    viewerPermissions: { actions: ALL_PR_ACTIONS, updateMethods: ["merge"] },
    mergeCapabilities: { merge: true, squash: true, rebase: false },
    ...overrides,
  };
}

describe("mobile pull request actions", () => {
  it("requires both provider support and account permission", () => {
    expect(
      canPerformPullRequestAction(detail({ viewerPermissions: { actions: [] } }), "merge"),
    ).toBe(false);
    expect(
      canPerformPullRequestAction(
        detail({ capabilities: { actions: [], mergeMethods: ["merge"] } }),
        "merge",
      ),
    ).toBe(false);
    expect(mergeUnavailableReason(detail(), false, GITHUB)).toContain("read-only");
  });

  it("blocks a conflicting PR's immediate merge and explains why", () => {
    const pr = detail({ mergeability: "conflicting" });
    expect(canPerformPullRequestAction(pr, "merge")).toBe(false);
    expect(mergeUnavailableReason(pr, true, GITHUB)).toContain("conflicts");
    expect(mergeSummary(pr, true, GITHUB)).toBe("Has conflicts");
  });

  it("names the change request with its host's term", () => {
    expect(pullRequestActionLabel("close", GITHUB)).toBe("Close pull request");
    expect(pullRequestActionLabel("close", GITLAB)).toBe("Close merge request");
    expect(pullRequestActionLabel("revert", GITLAB)).toBe("Create revert merge request");
    expect(mergeUnavailableReason(detail({ state: "merged" }), true, GITLAB)).toBe(
      "This merge request has been merged.",
    );
  });
});
