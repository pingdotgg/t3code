import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ viewed: false }));
const { passThrough } = vi.hoisted(() => ({
  passThrough: (props: { children?: unknown }) => props.children as never,
}));

vi.mock("react-native", () => ({ View: passThrough, Platform: { OS: "ios" } }));
vi.mock("./pullRequestAnimations", () => ({
  PR_ROW_LAYOUT: undefined,
  PR_ROW_ENTER: undefined,
  PR_ROW_EXIT: undefined,
}));
vi.mock("react-native-reanimated", () => ({ default: { View: passThrough } }));
vi.mock("@legendapp/list/reanimated", () => ({
  AnimatedLegendList: (props: {
    data: readonly { key: string }[];
    renderItem: (info: { item: unknown }) => ReactNode;
  }) => props.data.map((item) => <div key={item.key}>{props.renderItem({ item })}</div>),
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { popTo: () => ({}) },
  useNavigation: () => ({ goBack: () => {}, dispatch: () => {}, getState: () => undefined }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: passThrough }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: { accessibilityLabel?: string }) => (
    <div data-row aria-label={props.accessibilityLabel} />
  ),
}));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: passThrough }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: { detail: () => null } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("./PullRequestPresentation", () => ({
  PullRequestDiffStats: () => null,
  PullRequestReadStatus: () => null,
}));
vi.mock("./PullRequestSectionHeading", () => ({ PullRequestSectionHeading: () => null }));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: () => ({}),
  usePullRequestDiff: () => ({ isPending: false, error: null }),
}));
vi.mock("./usePullRequestFilesViewed", () => ({
  usePullRequestFilesViewed: () => ({ isViewed: () => harness.viewed }),
}));
vi.mock("./usePullRequestFileFilter", () => ({
  usePullRequestFileFilter: () => ({
    hideTestFiles: false,
    hiddenCount: 0,
    toggle: () => {},
    parsed: {
      kind: "files",
      fileCount: 1,
      additions: 1,
      deletions: 1,
      notice: null,
      files: [
        {
          id: "f1",
          cacheKey: "f1",
          path: "README.md",
          previousPath: null,
          changeType: "change",
          additions: 1,
          deletions: 1,
        },
      ],
    },
  }),
}));

import { PullRequestFilesSheet } from "./PullRequestFiles";

function rowLabel(viewed: boolean) {
  harness.viewed = viewed;
  const html = renderToStaticMarkup(
    <PullRequestFilesSheet
      route={{
        params: { environmentId: "env-1", repository: "owner/repo", number: 7 } as never,
      }}
    />,
  );
  return /data-row="true" aria-label="(View diff[^"]*)"/.exec(html)?.[1];
}

it("announces a one-line change in singular, as the pull request list does", () => {
  expect(rowLabel(false)).toBe("View diff for README.md, 1 addition, 1 deletion");
  expect(rowLabel(true)).toBe("View diff for README.md, 1 addition, 1 deletion, viewed");
});
