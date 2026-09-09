import { RegistryContext } from "@effect/atom-react";
import { it } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import {
  EnvironmentId,
  EnvironmentInternalError,
  ProjectId,
  WS_METHODS,
  type PullRequestDetail,
} from "@t3tools/contracts";
import type { CodeViewDiffItem } from "@pierre/diffs/react";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

const state = vi.hoisted(() => ({
  layer: null as Layer.Layer<EnvironmentRegistry | PullRequestDiffLoader> | null,
  registry: null as AtomRegistry.AtomRegistry | null,
  noop: () => {},
}));
const reference = { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 7 };
const environmentId = EnvironmentId.make("env-1");

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuTrigger: ({ children }: { children: ReactNode }) => children,
  MenuPopup: () => null,
  MenuItem: () => null,
  MenuRadioGroup: () => null,
  MenuRadioItem: () => null,
  MenuSeparator: () => null,
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
}));

vi.mock("~/connection/runtime", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.suspend(() => state.layer!)) };
});
vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry!;
  },
}));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.noop }));
vi.mock("~/lib/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => state.noop,
}));
vi.mock("~/state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({ diffLayout: "unified", wordWrap: false }),
  useUpdateClientSettings: () => state.noop,
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useLocalStorage", () => ({ useLocalStorage: () => [true, state.noop] }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: state.noop, isCopied: false }),
}));
vi.mock("./PullRequestSummaryTab", () => ({ PullRequestSummaryTab: () => null }));
vi.mock("./PullRequestTimelineTab", () => ({ PullRequestTimelineTab: () => null }));
vi.mock("./PullRequestMarkdown", async () => {
  const { createContext } = await import("react");
  return { PullRequestMarkdownContext: createContext(null) };
});
vi.mock("./PullRequestChecksPopover", () => ({ PullRequestChecksPopover: () => null }));
vi.mock("./PullRequestReviewBar", () => ({ PullRequestReviewBar: () => null }));
vi.mock("./PullRequestReviewAnnotation", () => ({
  PendingReviewCommentCard: () => null,
  ReviewThreadCard: () => null,
}));
vi.mock("../diffs/DiffFileTree", () => ({
  DiffFileTree: ({ footer }: { footer: ReactNode }) => footer,
}));
vi.mock("../diffs/StyledDiffCodeView", () => ({
  // Render parsed file names without starting the diff viewer's workers.
  StyledDiffCodeView: ({
    items,
    renderCodeViewFooter,
  }: {
    items: ReadonlyArray<CodeViewDiffItem>;
    renderCodeViewFooter?: () => ReactNode;
  }) => (
    <div data-testid="diff-viewer">
      {items.map((item) => (
        <span key={item.id}>{item.fileDiff.name}</span>
      ))}
      {renderCodeViewFooter?.()}
    </div>
  ),
}));

const pages = ["first.ts", "second.ts", "updated.ts", "manual.ts"].map((path, index) => ({
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  truncated: index === 0,
  nextCursor: index === 0 ? "page-2" : null,
  omittedFileStats: [],
}));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.registry = AtomRegistry.make();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  vi.unstubAllGlobals();
});

const failureKinds = [
  "files",
  "empty",
  "raw",
  "additional page",
  "multiple pages",
  "partial refresh",
] as const;
it.effect.each(failureKinds)("shows diff failures and supports retry for %s", (kind) =>
  Effect.gen(function* () {
    const h = yield* makeHarness("page");
    const initial =
      kind === "additional page" || kind === "multiple pages" || kind === "partial refresh"
        ? pages[0]!
        : {
            ...pages[1]!,
            patch:
              kind === "empty"
                ? ""
                : kind === "raw"
                  ? "Unstructured patch content"
                  : pages[1]!.patch,
          };
    h.updateDiff(initial);
    yield* Effect.promise(async () => {
      await act(async () => {
        renderer = create(h.panel());
      });
      const button = (text: string) =>
        renderer!.root.findAllByType("button").find((node) => node.children.includes(text))!;
      const click = {
        nativeEvent: new Event("click"),
        preventDefault: state.noop,
        currentTarget: { tagName: "BUTTON" },
      };
      await act(async () => {
        button("Code").props.onClick(click);
        await import("./PullRequestCodeTab");
      });
      if (kind === "multiple pages") {
        await act(async () => button("Load more files").props.onClick(click));
      }
      const content = () => JSON.stringify(renderer!.toJSON());
      const retained =
        kind === "empty"
          ? "This pull request has no file changes."
          : kind === "raw"
            ? initial.patch
            : kind === "additional page" || kind === "partial refresh"
              ? "first.ts"
              : "second.ts";
      expect(content()).toContain(retained);
      const loadDiff = h.loadDiff.getMockImplementation()!;
      const failure = Effect.fail(
        new EnvironmentInternalError({
          code: "internal_error",
          reason: "internal_error",
          traceId: "test-refresh-failure",
        }),
      );
      h.loadDiff.mockImplementation((connection, input) =>
        kind === "multiple pages" && input.cursor !== undefined
          ? loadDiff(connection, input)
          : failure,
      );
      h.loadDiff.mockClear();
      await act(async () => {
        if (kind === "additional page") button("Load more files").props.onClick(click);
        else renderer!.update(h.panel(1));
      });
      const errorText =
        kind === "additional page"
          ? "The rest of this diff could not be loaded."
          : "This diff could not be refreshed.";
      expect(content()).toContain(retained);
      expect(content()).toContain(errorText);
      if (kind === "multiple pages") {
        expect(h.loadDiff.mock.calls.every(([, input]) => input.cursor === undefined)).toBe(true);
      }
      const failedRequests = h.loadDiff.mock.calls.length;
      h.loadDiff.mockImplementation(loadDiff);
      if (kind === "multiple pages") h.updateSecondPage(pages[2]!);
      else if (kind !== "additional page") h.updateDiff(pages[2]!);
      await act(async () => button("Retry").props.onClick(click));
      expect(h.loadDiff).toHaveBeenCalledTimes(
        failedRequests + (kind === "multiple pages" ? 2 : 1),
      );
      expect(content()).not.toContain(errorText);
      expect(content()).toContain(kind === "additional page" ? "second.ts" : "updated.ts");
    });
  }),
);

const makeHarness = Effect.fn("PullRequestDetailPanelTest.makeHarness")(function* (
  context: "thread" | "page",
) {
  let detail: PullRequestDetail = {
    ...reference,
    provider: "github",
    projectTitle: "web",
    workspaceRoot: "/repo",
    title: "Review changes",
    body: "",
    url: "https://github.com/acme/web/pull/7",
    author: null,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 2,
    deletions: 2,
    changedFiles: 2,
    headBranch: "feature",
    baseBranch: "main",
    createdAt: "2026-09-07T10:00:00Z",
    updatedAt: "2026-09-07T10:00:00Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [],
    capabilities: {
      diff: true,
      comment: false,
      actions: [],
      mergeMethods: [],
      search: false,
      review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
    },
    viewerPermissions: {
      actions: [],
      comment: false,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
    },
    mergeCapabilities: { merge: false, squash: false, rebase: false },
  };
  const refreshes = yield* PubSub.unbounded<number>({ replay: 1 });
  yield* PubSub.publish(refreshes, 0);
  const readDetail = vi.fn(() => Effect.sync(() => ({ ...detail })));
  const invalidate = vi.fn(() => Effect.void);
  let firstPage = pages[0]!;
  let secondPage = pages[1]!;
  let diffGate: Promise<void> = Promise.resolve();
  const loadDiff = vi.fn<PullRequestDiffLoader["Service"]["load"]>((_connection, input) =>
    Effect.promise(async () => {
      await diffGate;
      return input.cursor === undefined ? firstPage : secondPage;
    }),
  );
  const client = {
    [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshes),
    [WS_METHODS.pullRequestsDetail]: readDetail,
    [WS_METHODS.pullRequestsActivity]: () =>
      Effect.succeed({
        author: null,
        reviewers: [],
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        reviewThreads: [],
        commits: [],
        reactions: [],
      }),
    [WS_METHODS.pullRequestsInvalidate]: invalidate,
    [WS_METHODS.vcsListRefs]: () => Effect.succeed({ refs: [] }),
  } as unknown as WsRpcProtocolClient;
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Test environment",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId,
        label: target.label,
        target,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: target.wsBaseUrl,
        httpAuthorization: null,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  state.layer = Layer.merge(
    Layer.succeed(
      EnvironmentRegistry,
      EnvironmentRegistry.of({
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        runStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]),
    ),
    Layer.succeed(PullRequestDiffLoader, PullRequestDiffLoader.of({ load: loadDiff })),
  );
  const registry = state.registry!;
  const panel = (refreshToken = 0) => (
    <RegistryContext.Provider value={registry}>
      <PullRequestDetailPanel
        environmentId={environmentId}
        reference={{ ...reference }}
        context={context}
        refreshToken={refreshToken}
      />
    </RegistryContext.Provider>
  );
  return {
    panel,
    refreshes,
    readDetail,
    invalidate,
    loadDiff,
    updateDetail: (updatedAt: string) => {
      detail = { ...detail, updatedAt };
    },
    updateDiff: (page: (typeof pages)[number]) => {
      firstPage = page;
    },
    updateSecondPage: (page: (typeof pages)[number]) => {
      secondPage = page;
    },
    pauseDiff: () => {
      let resume = state.noop;
      diffGate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return resume;
    },
  };
});

it.effect.each(["thread", "page"] as const)(
  "retains loaded diff pages across unchanged turns in the %s panel and reloads a changed PR",
  (context) =>
    Effect.gen(function* () {
      const h = yield* makeHarness(context);
      yield* Effect.promise(async () => {
        await act(async () => {
          renderer = create(h.panel());
        });
        const button = (text: string) =>
          renderer!.root.findAllByType("button").find((node) => node.children.includes(text))!;
        const click = {
          nativeEvent: new Event("click"),
          preventDefault: state.noop,
          currentTarget: { tagName: "BUTTON" },
        };
        await act(async () => {
          button("Code").props.onClick(click);
          await import("./PullRequestCodeTab");
        });
        await act(async () => button("Load more files").props.onClick(click));
        const viewer = () => renderer!.root.findByProps({ "data-testid": "diff-viewer" });
        const files = () =>
          viewer()
            .findAllByType("span")
            .map((node) => node.children.join(""));
        expect(files()).toEqual(["first.ts", "second.ts"]);
        const originalViewer = viewer();
        h.loadDiff.mockClear();
        h.readDetail.mockClear();
        await act(async () => {
          PubSub.publishUnsafe(h.refreshes, 1);
        });
        expect(h.readDetail).toHaveBeenCalled();
        expect(files()).toEqual(["first.ts", "second.ts"]);
        expect(viewer()).toBe(originalViewer);
        expect(h.loadDiff).not.toHaveBeenCalled();

        // Host metadata can change without changing any of the loaded diff pages.
        const resumeDiff = h.pauseDiff();
        await act(async () => {
          h.updateDetail("2026-09-07T10:00:30Z");
          PubSub.publishUnsafe(h.refreshes, 2);
        });
        expect(h.loadDiff).toHaveBeenCalledTimes(1);
        expect(files()).toEqual(["first.ts", "second.ts"]);
        expect(viewer()).toBe(originalViewer);
        await act(async () => resumeDiff());
        expect(files()).toEqual(["first.ts", "second.ts"]);
        expect(viewer()).toBe(originalViewer);
        expect(h.loadDiff).toHaveBeenCalledTimes(2);
        h.loadDiff.mockClear();

        // An unchanged first page must not hide changes on a later loaded page.
        await act(async () => {
          h.updateDetail("2026-09-07T10:00:45Z");
          h.updateSecondPage(pages[2]!);
          PubSub.publishUnsafe(h.refreshes, 3);
        });
        expect(files()).toEqual(["first.ts", "updated.ts"]);
        expect(h.loadDiff).toHaveBeenCalledTimes(2);
        h.loadDiff.mockClear();

        await act(async () => {
          h.updateDetail("2026-09-07T10:01:00Z");
          h.updateDiff(pages[2]!);
          PubSub.publishUnsafe(h.refreshes, 4);
        });
        expect(files()).toEqual(["updated.ts"]);
        expect(h.loadDiff).toHaveBeenCalledTimes(1);

        // A user-requested refresh still reloads even though updatedAt has not changed.
        await act(async () => {
          h.updateDiff(pages[3]!);
          renderer!.update(h.panel(1));
        });
        expect(files()).toEqual(["manual.ts"]);
        expect(h.invalidate).toHaveBeenCalledTimes(1);
        expect(h.loadDiff).toHaveBeenCalledTimes(2);
      });
    }),
);
