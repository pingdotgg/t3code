import type { PullRequestActivity } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Pressable: () => null,
  StyleSheet: {},
  View: () => null,
}));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("@tabler/icons-react-native/IconGitCommit", () => ({ default: () => null }));
vi.mock("@react-navigation/native", () => ({ StackActions: { push: vi.fn() } }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./PullRequestPresentation", () => ({ PullRequestAvatar: () => null }));
vi.mock("./PullRequestMarkdown", () => ({ PullRequestMarkdown: () => null }));
vi.mock("./PullRequestReactions", () => ({ PullRequestCommentFooter: () => null }));

import { pullRequestTimelineRows } from "./PullRequestTimeline";

type Args = Parameters<typeof pullRequestTimelineRows>;

const activity: PullRequestActivity = {
  comments: [
    {
      id: "newer",
      author: null,
      reviewState: null,
      kind: "issue-comment",
      body: "comment",
      createdAt: "2026-07-05T00:30:00Z",
      url: null,
      path: null,
    },
  ],
  commentCount: 1,
  commentsTruncated: true,
  commits: [{ oid: "older", messageHeadline: "older", committedDate: "2026-07-04T23:00:00Z" }],
  reviewThreads: [],
};

describe("pullRequestTimelineRows", () => {
  it("sorts in the chosen direction and keeps the truncation notice last", () => {
    const keys = (newestFirst: boolean) =>
      pullRequestTimelineRows(
        activity,
        {} as Args[1],
        {} as Args[2],
        {} as Args[3],
        newestFirst,
      ).map((row) => row.key);

    expect(keys(true)).toEqual(["comment:newer", "commit:older", "truncated"]);
    expect(keys(false)).toEqual(["commit:older", "comment:newer", "truncated"]);
  });
});
