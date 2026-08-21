import type { PullRequestLocalStack, PullRequestStackSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildPullRequestStackPickerModel } from "./PullRequestStackPicker";

const localStack: PullRequestLocalStack = {
  trunk: "main",
  currentBranch: "feature/two",
  steps: [
    {
      position: 1,
      branch: "feature/one",
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pullRequest: {
        number: 3,
        url: "https://github.com/bil0000/t3code/pull/3",
        state: "open",
      },
    },
    {
      position: 2,
      branch: "feature/two",
      isCurrent: true,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pullRequest: {
        number: 4,
        url: "https://github.com/bil0000/t3code/pull/4",
        state: "open",
      },
    },
  ],
};

const remoteStack: PullRequestStackSummary = {
  id: 5,
  number: 5,
  url: "https://api.github.com/repos/bil0000/t3code/stacks/5",
  baseBranch: "main",
  open: true,
  steps: [
    {
      position: 1,
      pullRequestNumber: 3,
      branch: "feature/one",
      state: "open",
      draft: false,
    },
    {
      position: 2,
      pullRequestNumber: 4,
      branch: "feature/two",
      state: "open",
      draft: false,
    },
  ],
};

const expectedModel = {
  baseBranch: "main",
  currentPosition: 2,
  steps: [
    {
      position: 1,
      branch: "feature/one",
      pullRequestNumber: 3,
      state: "open",
      isDraft: false,
      current: false,
      needsRebase: false,
      detail: "#3 · Open · bil0000/t3code",
    },
    {
      position: 2,
      branch: "feature/two",
      pullRequestNumber: 4,
      state: "open",
      isDraft: false,
      current: true,
      needsRebase: false,
      detail: "#4 · Open · bil0000/t3code",
    },
  ],
};

describe("pull request stack picker model", () => {
  it("gives the thread header and right panel the same menu", () => {
    expect(
      buildPullRequestStackPickerModel({
        kind: "local",
        repository: "bil0000/t3code",
        stack: localStack,
      }),
    ).toEqual(expectedModel);
    expect(
      buildPullRequestStackPickerModel({
        kind: "remote",
        repository: "bil0000/t3code",
        stack: remoteStack,
        pullRequestNumber: 4,
      }),
    ).toEqual(expectedModel);
  });

  it("preserves draft state for remote stack steps", () => {
    const model = buildPullRequestStackPickerModel({
      kind: "remote",
      repository: "bil0000/t3code",
      stack: {
        ...remoteStack,
        steps: remoteStack.steps.map((step) => ({ ...step, draft: true })),
      },
      pullRequestNumber: 4,
    });

    expect(model.steps[0]).toMatchObject({
      isDraft: true,
      detail: "#3 · Draft · bil0000/t3code",
    });
  });

  it("keeps an unsubmitted local step visible but unavailable", () => {
    const model = buildPullRequestStackPickerModel({
      kind: "local",
      repository: "bil0000/t3code",
      stack: {
        ...localStack,
        currentBranch: "feature/three",
        steps: [
          ...localStack.steps.map((step) => ({ ...step, isCurrent: false })),
          {
            position: 3,
            branch: "feature/three",
            isCurrent: true,
            isMerged: false,
            isQueued: false,
            needsRebase: false,
            pullRequest: null,
          },
        ],
      },
    });

    expect(model.currentPosition).toBe(3);
    expect(model.steps.at(-1)).toEqual({
      position: 3,
      branch: "feature/three",
      pullRequestNumber: null,
      state: "unsubmitted",
      isDraft: false,
      current: true,
      needsRebase: false,
      detail: "Not submitted · bil0000/t3code",
    });
  });
});
