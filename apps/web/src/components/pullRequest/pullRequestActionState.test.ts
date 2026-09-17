import { ProjectId, type PullRequestActionInput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  decodePullRequestActionOutcome,
  inspectionInput,
  readStoredPullRequestAction,
  writeStoredPullRequestAction,
} from "./pullRequestActionState";

const input: PullRequestActionInput = {
  projectId: ProjectId.make("project-1"),
  host: "git.cafe",
  repository: "acme/web",
  number: 7,
  action: "merge" as const,
  mergeMethod: "squash" as const,
  requestId: "request-1",
};

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};

describe("pull request action recovery state", () => {
  it("round trips the exact submitted input and adds only the operation when inspecting", () => {
    const store = storage();
    const action = {
      input,
      operation: { kind: "merge" as const, id: "operation-1" },
      state: "pending" as const,
      detail: "Waiting for the merge worker.",
    };
    writeStoredPullRequestAction(store, "env-1", action, input);
    const restored = readStoredPullRequestAction(store, "env-1", input);
    expect(restored).toEqual(action);
    expect(inspectionInput(restored!)).toEqual({ ...input, operation: action.operation });
  });

  it("isolates hosts and rejects malformed outcomes", () => {
    const store = storage();
    writeStoredPullRequestAction(
      store,
      "env-1",
      { input, state: "unknown", detail: "The result could not be confirmed." },
      input,
    );
    expect(
      readStoredPullRequestAction(store, "env-1", { ...input, host: "staging.git.cafe" }),
    ).toBeNull();
    expect(
      decodePullRequestActionOutcome({ state: "pending", detail: "missing operation" }),
    ).toBeNull();
  });

  it("restores an immutable attempt before an operation has been admitted", () => {
    const store = storage();
    const attempt = {
      input,
      state: "unknown" as const,
      detail: "The request was sent, but its result has not been confirmed yet.",
    };
    writeStoredPullRequestAction(store, "env-1", attempt, input);

    expect(readStoredPullRequestAction(store, "env-1", input)).toEqual(attempt);
    expect(inspectionInput(attempt)).toBeNull();
    expect(inspectionInput(attempt, { kind: "stack-land", id: "latest" })).toEqual({
      ...input,
      operation: { kind: "stack-land", id: "latest" },
    });
  });

  it("uses one recovery scope for every viewed layer in a stack", () => {
    const store = storage();
    const submitted = { ...input, number: 3, stackNumber: 12 };
    const attempt = {
      input: submitted,
      state: "unknown" as const,
      detail: "Waiting for confirmation.",
    };
    writeStoredPullRequestAction(store, "env-1", attempt, submitted);

    expect(readStoredPullRequestAction(store, "env-1", { ...submitted, number: 5 })).toEqual(
      attempt,
    );
    expect(readStoredPullRequestAction(store, "env-1", { ...submitted, number: 8 })).toEqual(
      attempt,
    );
  });
});
