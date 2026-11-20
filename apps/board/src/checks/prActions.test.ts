import { describe, expect, it } from "vite-plus/test";

import { type PrActionDetail, prActions } from "./prActions";

const detail = (fields: Partial<PrActionDetail> = {}): PrActionDetail => ({
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  baseComparison: "up-to-date",
  capabilities: {
    actions: ["ready", "draft", "update-branch"],
    updateMethods: ["merge", "rebase"],
  },
  viewerPermissions: {
    actions: ["ready", "draft", "update-branch"],
    updateMethods: ["rebase"],
  },
  ...fields,
});

const summary = (input: PrActionDetail) => {
  const actions = prActions(input);
  return actions === null
    ? null
    : [actions.primary, ...actions.menu].map(({ kind, unavailable }) => [kind, unavailable]);
};

describe("a pull request's actions", () => {
  it("Given a draft, when its actions are read, then marking it ready is the button", () => {
    const actions = prActions(detail({ isDraft: true }));
    expect(actions?.primary).toMatchObject({ kind: "ready", unavailable: null });
    expect(actions?.menu.map((action) => [action.kind, action.unavailable])).toEqual([
      ["update-branch", "Up to date"],
      ["draft", "Already a draft"],
    ]);
  });

  it("Given a ready pull request behind its base, when its actions are read, then updating the branch is the button, by the method the viewer may use", () => {
    const actions = prActions(detail({ baseComparison: "behind" }));
    expect(actions?.primary).toMatchObject({ kind: "update-branch", updateMethod: "rebase" });
    expect(actions?.menu.map((action) => action.kind)).toEqual(["ready", "draft"]);
  });

  it("Given an up-to-date ready pull request, when its actions are read, then converting to draft is the button", () => {
    expect(summary(detail())).toEqual([
      ["draft", null],
      ["ready", "Already ready"],
      ["update-branch", "Up to date"],
    ]);
  });

  it("Given a behind pull request with conflicts, when its actions are read, then the update says to resolve them first", () => {
    const actions = prActions(detail({ baseComparison: "behind", mergeability: "conflicting" }));
    expect(actions?.menu.find((action) => action.kind === "update-branch")?.unavailable).toBe(
      "Resolve conflicts first",
    );
  });

  it("Given a viewer who may not change a draft, when its actions are read, then the button is the ready action, off, with the reason", () => {
    const actions = prActions(
      detail({
        isDraft: true,
        viewerPermissions: { actions: [], updateMethods: [] },
      }),
    );
    expect(actions?.primary).toMatchObject({ kind: "ready", unavailable: "Not allowed" });
  });

  it("Given a merged or closed pull request, when its actions are read, then there are none", () => {
    expect(prActions(detail({ state: "merged" }))).toBeNull();
    expect(prActions(detail({ state: "closed" }))).toBeNull();
  });
});
