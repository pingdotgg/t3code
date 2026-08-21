import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PullRequestLocalStack,
  PullRequestStackActionInput,
  PullRequestStackError,
  PullRequestStackListResult,
  PullRequestStackSummary,
} from "./pullRequestStack.ts";

const decodeStackSummary = Schema.decodeUnknownSync(PullRequestStackSummary);
const decodeLocalStack = Schema.decodeUnknownSync(PullRequestLocalStack);
const decodeStackActionInput = Schema.decodeUnknownSync(PullRequestStackActionInput);
const decodeStackError = Schema.decodeUnknownSync(PullRequestStackError);

const STACK = {
  id: 41,
  number: 7,
  url: "https://api.github.com/repos/acme/app/stacks/7",
  baseBranch: "main",
  open: true,
  steps: [
    {
      position: 1,
      pullRequestNumber: 10,
      branch: "auth",
      state: "open",
      draft: false,
    },
    {
      position: 2,
      pullRequestNumber: 11,
      branch: "api",
      state: "open",
      draft: true,
    },
  ],
} as const;

describe("PullRequestStackSummary", () => {
  it("keeps remote stack steps in bottom-to-top order", () => {
    const decoded = decodeStackSummary(STACK);

    expect(decoded.steps.map((step) => step.pullRequestNumber)).toEqual([10, 11]);
  });

  it("round-trips through the JSON codec used by RPC", () => {
    const codec = Schema.toCodecJson(PullRequestStackListResult);
    const input = {
      availability: "available",
      stacks: [STACK],
    } as const;

    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(input));

    expect(decoded).toStrictEqual(input);
  });
});

describe("PullRequestLocalStack", () => {
  it("accepts tracked pull requests without a stored URL", () => {
    const decoded = decodeLocalStack({
      trunk: "main",
      currentBranch: "auth",
      steps: [
        {
          position: 1,
          branch: "auth",
          isCurrent: true,
          isMerged: false,
          isQueued: false,
          needsRebase: false,
          pullRequest: { number: 10, state: "open" },
        },
      ],
    });

    expect(decoded.steps[0]?.pullRequest).toEqual({ number: 10, state: "open" });
  });

  it("keeps local branch health and the current step", () => {
    const decoded = decodeLocalStack({
      trunk: "main",
      currentBranch: "api",
      steps: [
        {
          position: 1,
          branch: "auth",
          head: "a1",
          base: "main",
          isCurrent: false,
          isMerged: false,
          isQueued: false,
          needsRebase: false,
          pullRequest: {
            number: 10,
            url: "https://github.com/acme/app/pull/10",
            state: "open",
          },
        },
        {
          position: 2,
          branch: "api",
          head: "b2",
          base: "auth",
          isCurrent: true,
          isMerged: false,
          isQueued: false,
          needsRebase: true,
          pullRequest: null,
        },
      ],
    });

    expect(decoded.steps.find((step) => step.isCurrent)?.position).toBe(2);
    expect(decoded.steps[1]?.needsRebase).toBe(true);
  });
});

describe("PullRequestStackActionInput", () => {
  it("rejects a blank branch name", () => {
    expect(() =>
      decodeStackActionInput({
        cwd: "/workspace/app",
        action: "add_step",
        branch: "   ",
      }),
    ).toThrow();
  });
});

describe("PullRequestStackError", () => {
  it("keeps the project id when its workspace cannot be resolved", () => {
    const decoded = decodeStackError({
      _tag: "PullRequestStackError",
      operation: "pullRequestStacks.resolveProject",
      projectId: "project-1",
      detail: "Project was not found.",
    });

    expect(decoded).toEqual(expect.objectContaining({ projectId: "project-1" }));
    expect(decoded).not.toHaveProperty("cwd");
  });
});
