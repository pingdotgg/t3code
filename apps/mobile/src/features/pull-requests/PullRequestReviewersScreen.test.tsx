import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type FlatListProps = {
  readonly data: readonly unknown[];
  readonly renderItem: (info: { readonly item: unknown; readonly index: number }) => ReactNode;
  readonly renderScrollComponent: (props: {
    readonly children: ReactNode;
  }) => ReactElement<{ readonly children?: ReactNode }>;
  readonly ListHeaderComponent?: ReactNode;
  readonly ListFooterComponent?: ReactNode;
  readonly ListEmptyComponent?: ReactNode;
};

vi.mock("react-native", async () => {
  const React = await import("react");
  const Element = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  class ClassFlatList extends React.Component<FlatListProps> {
    override render() {
      const { data, renderItem, renderScrollComponent } = this.props;
      const children = data.length
        ? [
            this.props.ListHeaderComponent,
            ...data.map((item, index) => renderItem({ item, index })),
            this.props.ListFooterComponent,
          ]
        : [this.props.ListEmptyComponent];
      // VirtualizedList invokes this callback from its class render and clones the returned element.
      return React.cloneElement(renderScrollComponent({ children }), { children });
    }
  }
  return {
    FlatList: ClassFlatList,
    Platform: { OS: "ios", Version: 27 },
    Pressable: Element,
    ScrollView: Element,
    View: Element,
  };
});

vi.mock("expo", () => ({
  requireNativeView: () => () => null,
  requireOptionalNativeModule: () => null,
}));
vi.mock("react-native-screens", () => ({
  ScrollViewMarker: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@t3tools/client-runtime/source-control-clients", () => ({
  sourceControlClients: { get: () => ({ changeRequest: { singular: "pull request" } }) },
}));
vi.mock("@t3tools/client-runtime/pull-request-reviewers", () => ({
  hostReviewerQuery: () => null,
  reviewerCandidateView: () => ({
    candidates: [{ id: "alice", kind: "user", login: "alice", name: "Alice", isRequested: false }],
    searchError: null,
    searchPending: false,
    truncation: null,
  }),
}));

const atoms = vi.hoisted(() => ({ detail: {}, candidates: {} }));
vi.mock("../../state/pull-requests", () => ({
  composerPullRequests: {
    detail: () => atoms.detail,
    reviewerCandidates: () => atoms.candidates,
    reviewerSearch: () => ({}),
    requestReviewers: Object.assign(vi.fn(), { permissionAtom: () => ({}) }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === atoms.detail
      ? {
          data: {
            state: "open",
            provider: "github",
            capabilities: {
              reviewers: { request: true, listCandidates: true, searchCandidates: false },
            },
            viewerPermissions: { requestReviewers: true },
          },
          error: null,
          isPending: false,
          refresh: vi.fn(),
        }
      : {
          data:
            atom === atoms.candidates
              ? [{ id: "alice", kind: "user", login: "alice", name: "Alice", isRequested: false }]
              : null,
          error: null,
          isPending: false,
          refresh: vi.fn(),
        },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: unknown) => value }));
vi.mock("../../components/ui/useBarInset", () => ({
  useContentTopInset: () => 0,
  useSearchToolbarInset: () => 0,
}));
vi.mock("./usePullRequestConnected", () => ({ usePullRequestConnected: () => true }));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (params: { readonly environmentId: string }) => ({
    environmentId: params.environmentId,
  }),
}));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: () => null,
}));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./PullRequestPresentation", () => ({
  PullRequestAvatar: ({ actor }: { readonly actor: { readonly login: string } }) => (
    <span>{actor.login}</span>
  ),
}));

import { PullRequestReviewersScreen } from "./PullRequestReviewersScreen";

it("renders reviewer rows when FlatList invokes and clones its scroll renderer", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const route = {
    environmentId: "environment",
    projectId: "project",
    repository: "repo",
    number: 1,
  };

  act(() => {
    root.render(<PullRequestReviewersScreen route={{ params: route } as never} />);
  });

  expect(container.textContent).toContain("alice");
  act(() => root.unmount());
});
