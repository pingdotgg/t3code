import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  act,
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => serverConfigs.get(environmentId),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/hooks/useSettings")>();
  const settings = { ...actual.getClientSettings(), browserLinkTarget: "system" as const };
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../ui/preview-card", () => ({
  PreviewCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  PreviewCardTrigger: ({
    render,
  }: ComponentProps<typeof import("../ui/preview-card").PreviewCardTrigger>) => render,
  PreviewCardPopup: () => null,
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false }),
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () =>
    vi.fn(async () => ({ _tag: "Success", value: { url: pullRequestUrl } })),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("~/state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => projects,
  useServerConfigs: () => serverConfigs,
}));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => primaryEnvironmentId }));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("~/editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));

import {
  PULL_REQUESTS_PANEL_REF,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import type { PullRequestsSearch } from "~/routes/_chat.pull-requests";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";

const primaryEnvironmentId = EnvironmentId.make("primary-environment");
const environmentId = EnvironmentId.make("pull-request-environment");
const threadRef = { environmentId, threadId: ThreadId.make("thread-with-pull-request") };
const repositoryUrl = "https://github.com/acme/repository";
const pullRequestUrl = `${repositoryUrl}/pull/42`;
const projects = [primaryEnvironmentId, environmentId].map((projectEnvironmentId) => ({
  id: ProjectId.make(`project-${projectEnvironmentId}`),
  environmentId: projectEnvironmentId,
  repositoryIdentity: {
    provider: "github",
    canonicalKey: "github.com/acme/repository",
    displayName: "Acme/Repository",
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: `${repositoryUrl}.git` },
  },
}));
const serverConfigs = new Map(
  [primaryEnvironmentId, environmentId].map((id) => [
    id,
    { environment: { capabilities: { pullRequests: true } } },
  ]),
);
const initialSearch: PullRequestsSearch = {
  involvement: "reviewing",
  state: "open",
  sort: "updated",
  q: "label:bug",
  host: "github.com",
  environmentId: primaryEnvironmentId,
  projectId: ProjectId.make("list-project"),
  repository: "acme/previous",
  number: 41,
  selectedProjectId: ProjectId.make(`project-${primaryEnvironmentId}`),
  selectedEnvironmentId: primaryEnvironmentId,
};

describe("pull request markdown links", () => {
  let renderer: ReactTestRenderer | undefined;
  let currentSearch: PullRequestsSearch;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    currentSearch = initialSearch;
    navigate.mockReset();
    navigate.mockImplementation(
      ({
        search,
      }: {
        search: PullRequestsSearch | ((previous: PullRequestsSearch) => PullRequestsSearch);
      }) => {
        currentSearch = typeof search === "function" ? search(currentSearch) : search;
        return Promise.resolve();
      },
    );
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  async function clickLink(
    content: ReactElement,
    modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
  ) {
    await act(async () => {
      renderer = create(content);
    });
    const link = renderer!.root.findByType("a").props as ComponentProps<"a">;
    const event = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...modifiers,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    await act(async () => link.onClick?.(event as MouseEvent<HTMLAnchorElement>));
    return event;
  }

  function markdown(url = pullRequestUrl) {
    return (
      <PullRequestMarkdown
        text={`[Pull request](${url})`}
        cwd="/project"
        environmentId={environmentId}
      />
    );
  }

  it("opens a linked pull request in the page panel on the source environment", async () => {
    const event = await clickLink(markdown());

    expect(event.defaultPrevented).toBe(true);
    expect(
      selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        PULL_REQUESTS_PANEL_REF,
      ),
    ).toMatchObject({
      kind: "pull-request",
      environmentId,
      projectId: `project-${environmentId}`,
      repository: "Acme/Repository",
      number: 42,
    });
    expect(currentSearch).toEqual({
      ...initialSearch,
      repository: "Acme/Repository",
      number: 42,
      selectedProjectId: `project-${environmentId}`,
      selectedEnvironmentId: environmentId,
    });
  });

  it("opens code comment links beside the thread inherited from the panel", async () => {
    const event = await clickLink(
      <PullRequestMarkdownContext value={{ repositoryUrl, threadRef }}>
        {markdown()}
      </PullRequestMarkdownContext>,
    );

    expect(event.defaultPrevented).toBe(true);
    const surface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    expect(surface).toMatchObject({
      kind: "pull-request",
      projectId: `project-${environmentId}`,
      repository: "Acme/Repository",
      number: 42,
    });
    expect(surface).not.toHaveProperty("environmentId");
    expect(
      selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        PULL_REQUESTS_PANEL_REF,
      ),
    ).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens a bare reference in the page panel after confirming it is a pull request", async () => {
    const event = await clickLink(
      <PullRequestMarkdownContext value={{ repositoryUrl, threadRef: null }}>
        <PullRequestMarkdown text="Related to #42" cwd="/project" environmentId={environmentId} />
      </PullRequestMarkdownContext>,
    );

    expect(event.defaultPrevented).toBe(true);
    expect(
      selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        PULL_REQUESTS_PANEL_REF,
      ),
    ).toMatchObject({
      kind: "pull-request",
      environmentId,
      projectId: `project-${environmentId}`,
      repository: "Acme/Repository",
      number: 42,
    });
    expect(currentSearch).toEqual({
      ...initialSearch,
      repository: "Acme/Repository",
      number: 42,
      selectedProjectId: `project-${environmentId}`,
      selectedEnvironmentId: environmentId,
    });
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])(
    "leaves modified clicks to the browser (%j)",
    async (modifiers) => {
      const event = await clickLink(markdown(), modifiers);

      expect(event.defaultPrevented).toBe(false);
      expect(useRightPanelStore.getState().byThreadKey).toEqual({});
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("keeps a link to an unavailable repository as an ordinary browser link", async () => {
    const event = await clickLink(markdown("https://github.com/other/repository/pull/42"));

    expect(event.defaultPrevented).toBe(false);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(navigate).not.toHaveBeenCalled();
  });
});
