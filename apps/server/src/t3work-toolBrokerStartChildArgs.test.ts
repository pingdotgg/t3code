import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  buildStartChildModelSelection,
  readStartChildArgs,
} from "./t3work-toolBrokerStartChildArgs.ts";

describe("buildStartChildModelSelection", () => {
  it("normalizes codex model aliases from start_child tool args", () => {
    const selection = buildStartChildModelSelection(
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
      {
        model: "gpt-5",
        reasoningEffort: "medium",
      },
    );

    expect(selection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });
});

describe("readStartChildArgs", () => {
  it("accepts a repo-scoped child request with a base ref", () => {
    expect(
      readStartChildArgs({
        name: "Review repo child",
        execution_scope: "repository",
        repo_full_name: "pingdotgg/t3code",
        repo_ref: "release/7.0",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Review repo child",
        executionScope: "repository",
        repoFullName: "pingdotgg/t3code",
        repoRef: "release/7.0",
      },
    });
  });

  it("rejects repository scope without repo_full_name", () => {
    expect(
      readStartChildArgs({
        name: "Detached child",
        execution_scope: "repository",
        repo_ref: "abc1234",
      }),
    ).toEqual({
      ok: false,
      message:
        "t3work.thread.start_child with execution_scope='repository' requires 'repo_full_name' so the runtime can create a dedicated linked-repository worktree.",
    });
  });

  it("rejects metarepo scope with repository fields", () => {
    expect(
      readStartChildArgs({
        name: "Planning child",
        execution_scope: "metarepo",
        repo_full_name: "pingdotgg/t3code",
      }),
    ).toEqual({
      ok: false,
      message:
        "t3work.thread.start_child with execution_scope='metarepo' must not include 'repo_full_name' or 'repo_ref'; use execution_scope='repository' with 'repo_full_name' for repository work.",
    });
  });

  it("requires an explicit execution scope", () => {
    expect(
      readStartChildArgs({
        name: "Ambiguous child",
      }),
    ).toEqual({
      ok: false,
      message:
        "t3work.thread.start_child requires 'execution_scope' set to 'metarepo' or 'repository'.",
    });
  });

  it("rejects an invalid execution scope value", () => {
    expect(
      readStartChildArgs({
        name: "Typo child",
        execution_scope: "metrepo",
      }),
    ).toEqual({
      ok: false,
      message:
        "t3work.thread.start_child 'execution_scope' must be exactly 'metarepo' or 'repository'. Use 'metarepo' for project planning/triage/synthesis and 'repository' for code, tests, debugging, review, or PR work.",
    });
  });

  it("rejects metarepo scope with only repo_ref", () => {
    expect(
      readStartChildArgs({
        name: "Planning child",
        execution_scope: "metarepo",
        repo_ref: "main",
      }),
    ).toEqual({
      ok: false,
      message:
        "t3work.thread.start_child with execution_scope='metarepo' must not include 'repo_full_name' or 'repo_ref'; use execution_scope='repository' with 'repo_full_name' for repository work.",
    });
  });
});
