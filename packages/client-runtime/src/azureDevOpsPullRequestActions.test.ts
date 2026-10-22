import { describe, expect, it } from "vite-plus/test";
import {
  azureBranchActions,
  azureCompletionBlock,
  azureCompletionOptions,
  azureReviewerStatus,
  emptyAzureCompletionDraft as draft,
  parseAzureWorkItemIds,
} from "./azureDevOpsPullRequestActions.ts";

const open = { state: "open", isDraft: false } as const;

describe("azureCompletionOptions", () => {
  it("defaults to a strategy branch policy allows", () => {
    expect(azureCompletionOptions(draft, undefined, undefined).strategy).toBe("noFastForward");
    expect(azureCompletionOptions(draft, ["squash"], undefined).strategy).toBe("squash");
    expect(azureCompletionOptions(draft, ["rebase", "rebaseMerge"], undefined).strategy).toBe(
      "rebase",
    );
  });

  it("prefers the armed auto-complete strategy while policy allows it", () => {
    expect(azureCompletionOptions(draft, ["noFastForward", "squash"], "squash").strategy).toBe(
      "squash",
    );
    expect(azureCompletionOptions(draft, ["squash", "rebaseMerge"], "rebase").strategy).toBe(
      "rebaseMerge",
    );
    expect(azureCompletionOptions(draft, ["squash"], "merge").strategy).toBe("squash");
    expect(azureCompletionOptions(draft, [], "squash").strategy).toBe("squash");
  });

  it("keeps a deliberate pick even when policy refuses it", () => {
    const picked = { ...draft, strategy: "rebase" } as const;
    expect(azureCompletionOptions(picked, ["squash"], "squash").strategy).toBe("rebase");
  });
});

describe("azureCompletionBlock", () => {
  const options = { ...draft, strategy: "squash" } as const;

  it("allows an open, published pull request with a permitted strategy", () => {
    expect(azureCompletionBlock(options, open, {}, ["squash"])).toBeUndefined();
    expect(azureCompletionBlock(options, open, {}, undefined)).toBeUndefined();
  });

  it("refuses closed, merged, and draft pull requests", () => {
    expect(azureCompletionBlock(options, { state: "merged", isDraft: false }, {}, undefined)).toBe(
      "Only an open pull request can be completed.",
    );
    expect(azureCompletionBlock(options, { state: "open", isDraft: true }, {}, undefined)).toBe(
      "Publish this draft before completing it.",
    );
  });

  it("reports the permission each chosen option needs", () => {
    expect(azureCompletionBlock(options, open, { complete: "No complete" }, undefined)).toBe(
      "No complete",
    );
    const denied = { "delete-source": "No delete", "bypass-policy": "No bypass" };
    expect(azureCompletionBlock(options, open, denied, undefined)).toBeUndefined();
    expect(
      azureCompletionBlock({ ...options, deleteSourceBranch: true }, open, denied, undefined),
    ).toBe("No delete");
    expect(
      azureCompletionBlock(
        { ...options, bypassPolicy: true, bypassReason: "hotfix" },
        open,
        denied,
        undefined,
      ),
    ).toBe("No bypass");
  });

  it("requires a reason to override policies, which then lifts the strategy restriction", () => {
    const bypass = { ...options, strategy: "rebase", bypassPolicy: true } as const;
    expect(azureCompletionBlock({ ...bypass, bypassReason: "  " }, open, {}, ["squash"])).toBe(
      "Enter a reason for overriding branch policies.",
    );
    expect(
      azureCompletionBlock({ ...bypass, bypassReason: "hotfix" }, open, {}, ["squash"]),
    ).toBeUndefined();
    expect(azureCompletionBlock({ ...bypass, bypassPolicy: false }, open, {}, ["squash"])).toBe(
      "Branch policy does not allow this merge strategy.",
    );
  });
});

describe("azureBranchActions", () => {
  const pr = { state: "open", baseBranch: "main" } as const;

  it("needs a target branch for every action and trims typed names", () => {
    expect(azureBranchActions(pr, "  ", "hotfix")).toEqual({
      retarget: null,
      cherryPick: null,
      revert: null,
    });
    expect(azureBranchActions(pr, " release ", " hotfix ")).toEqual({
      retarget: { type: "retarget", branch: "release" },
      cherryPick: {
        type: "cherry-pick",
        createPullRequest: true,
        targetBranch: "release",
        newBranch: "hotfix",
      },
      revert: null,
    });
  });

  it("retargets only an open pull request to a different branch", () => {
    expect(azureBranchActions(pr, " main ", "").retarget).toBeNull();
    expect(azureBranchActions({ ...pr, state: "merged" }, "release", "").retarget).toBeNull();
  });

  it("reverts only a merged pull request", () => {
    expect(azureBranchActions({ ...pr, state: "merged" }, "main", "undo").revert).toEqual({
      type: "revert",
      createPullRequest: true,
      targetBranch: "main",
      newBranch: "undo",
    });
  });
});

describe("parseAzureWorkItemIds", () => {
  it("reads numbers separated by commas or whitespace", () => {
    expect(parseAzureWorkItemIds(" 12, 34\n56 ")).toEqual([12, 34, 56]);
  });

  it("rejects anything Azure would not accept as a work item number", () => {
    for (const text of ["", " , ", "0", "-1", "1.5", "0x1F", "1e3", "12a", "99999999999999999999"])
      expect(parseAzureWorkItemIds(text)).toBeNull();
    expect(parseAzureWorkItemIds(Array.from({ length: 26 }, (_, i) => i + 1).join(","))).toBeNull();
  });
});

describe("azureReviewerStatus", () => {
  it("names the vote and every flag a reviewer carries", () => {
    const reviewer = {
      id: "1",
      login: "a",
      name: "A",
      group: false,
      vote: -5,
      required: true,
      declined: true,
      flagged: true,
    };
    expect(azureReviewerStatus(reviewer)).toBe(
      "Waiting for author · Required · Declined · Flagged",
    );
    expect(
      azureReviewerStatus({
        ...reviewer,
        vote: 0,
        required: false,
        declined: false,
        flagged: false,
      }),
    ).toBe("No vote");
  });
});
