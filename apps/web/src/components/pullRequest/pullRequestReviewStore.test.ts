import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  type PendingReviewComment,
  pullRequestReviewKey,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

function comment(id: string, body = id): PendingReviewComment {
  return { id, body, path: "src/app.ts", position: { kind: "added", newLine: 1 } };
}

describe("pull request review drafts", () => {
  beforeEach(() => {
    usePullRequestReviewStore.setState({
      drafts: {},
      summaries: {},
      codeViews: {},
      codeDraftTexts: {},
      codePositions: {},
    });
  });

  it("keeps a Code tab's view for the commit it was made on, for the latest pull requests", () => {
    const { updateCodeView, setCodeDraftText, saveCodePosition } =
      usePullRequestReviewStore.getState();
    const draft = {
      path: "src/app.ts",
      oldPath: null,
      version: 1,
      position: { kind: "added", newLine: 1 },
      range: { start: 1, end: 1 },
    } as const;
    updateCodeView("a", () => ({ foldChoices: new Map([["src/app.ts", true]]), draft }));
    setCodeDraftText("a", "Unsent");
    saveCodePosition("a", { path: "src/app.ts", offset: 40, pages: 3 });

    // Selecting the commit already shown, as opening a file from the guide does, keeps the view.
    updateCodeView("a", () => ({ commit: null }));
    updateCodeView("a", () => ({ selectedLines: { path: "src/app.ts", range: draft.range } }));
    expect(usePullRequestReviewStore.getState()).toMatchObject({
      codeViews: { a: { draft, foldChoices: new Map([["src/app.ts", true]]) } },
      codeDraftTexts: { a: "Unsent" },
      codePositions: { a: { pages: 3 } },
    });

    updateCodeView("a", () => ({ commit: "abc" }));
    expect(usePullRequestReviewStore.getState()).toMatchObject({
      codeViews: { a: { commit: "abc", draft: null, foldChoices: new Map() } },
      codeDraftTexts: {},
      codePositions: {},
    });

    for (let index = 0; index < 20; index += 1) {
      updateCodeView(`later-${index}`, () => ({ commit: "abc" }));
    }
    expect(Object.keys(usePullRequestReviewStore.getState().codeViews)).toHaveLength(20);
    expect(usePullRequestReviewStore.getState().codeViews.a).toBeUndefined();
  });

  it("removes only the line comments included in a submitted snapshot", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("submitted"));
    const submittedIds =
      usePullRequestReviewStore.getState().drafts["review-a"]?.map((entry) => entry.id) ?? [];

    usePullRequestReviewStore.getState().addComment("review-a", comment("added-in-flight"));
    usePullRequestReviewStore.getState().removeComments("review-a", submittedIds);

    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([
      comment("added-in-flight"),
    ]);
  });

  it("keeps drafts on different hosts separate when a thread reviews the same repository and number", () => {
    const reference = {
      projectId: ProjectId.make("project-a"),
      repository: "owner/repo",
      number: 7,
    };
    const publicKey = pullRequestReviewKey({ ...reference, host: "github.com" });
    const enterpriseKey = pullRequestReviewKey({ ...reference, host: "github.example.com" });
    const store = usePullRequestReviewStore.getState();
    store.addComment(publicKey, comment("public"));
    store.setSummary(publicKey, "Public review");

    expect(usePullRequestReviewStore.getState().drafts[enterpriseKey]).toBeUndefined();
    expect(usePullRequestReviewStore.getState().summaries[enterpriseKey]).toBeUndefined();

    store.addComment(enterpriseKey, comment("enterprise"));
    store.setSummary(enterpriseKey, "Enterprise review");
    store.clear(enterpriseKey);
    store.clearSummary(enterpriseKey, "Enterprise review");

    expect(usePullRequestReviewStore.getState().drafts[publicKey]).toEqual([comment("public")]);
    expect(usePullRequestReviewStore.getState().summaries[publicKey]).toBe("Public review");
  });

  it("does not clear a summary revised while submission is in flight", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Submitted body");
    usePullRequestReviewStore.getState().setSummary("review-a", "Revised body");
    usePullRequestReviewStore.getState().clearSummary("review-a", "Submitted body");

    expect(usePullRequestReviewStore.getState().summaries["review-a"]).toBe("Revised body");
  });
});
