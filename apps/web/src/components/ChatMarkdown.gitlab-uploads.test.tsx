import { EnvironmentId } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  failed: false,
  url: "https://t3.test/api/assets/first/image",
  refresh: () => {},
}));
vi.mock("../assets/assetUrls", async () => {
  const { useReducer } = await import("react");
  return {
    useAssetUrlState: () => {
      const [, refresh] = useReducer((version: number) => version + 1, 0);
      state.refresh = refresh;
      return state.failed ? { _tag: "Failure" } : { _tag: "Success", url: state.url };
    },
    useAssetUrlRefresh: () => async () => {
      state.failed = false;
      state.url = "https://t3.test/api/assets/refreshed/image";
      state.refresh();
    },
  };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./pullRequest/PullRequestMarkdown";

const environmentId = EnvironmentId.make("images-test");
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.failed = false;
  state.url = "https://t3.test/api/assets/first/image";
  vi.unstubAllGlobals();
});

const secret = "66dbcd21ec5d24ed6ea225176098d52b";
const context = { repositoryUrl: "http://gitlab.local/team/project", host: "gl.here" };
const imagePath = `/uploads/${secret}/my%20image.png`;
const videoPath = `/uploads/${secret}/clip%2Emp4#t=2`;
const view = (text: string) => (
  <PullRequestMarkdownContext
    value={{ repositoryUrl: null, gitlabUploads: context, threadRef: null }}
  >
    <PullRequestMarkdown cwd="/worktree" environmentId={environmentId} text={text} />
  </PullRequestMarkdownContext>
);

describe("GitLab MR media", () => {
  it("loads a relative upload through a signed URL, falls back once, and recovers on refresh", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(view(`![shot](${imagePath})`));
    });
    expect(renderer!.root.findByType("img").props.src).toBe(state.url);
    await act(async () => renderer!.root.findByType("img").props.onError());
    expect(renderer!.root.findByType("img").props.src).toBe(context.repositoryUrl + imagePath);
    await act(async () => renderer!.root.findByType("img").props.onError());
    expect(renderer!.root.findAllByType("img")).toHaveLength(0);
    state.url = "https://t3.test/api/assets/refreshed/image";
    await act(async () => state.refresh());
    expect(renderer!.root.findByType("img").props.src).toBe(state.url);
  });

  it("preserves authored dimensions and falls back when an older server cannot sign uploads", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.failed = true;
    await act(async () => {
      renderer = create(view(`<img width="120" src="${imagePath}" alt="shot">`));
    });
    await act(async () => renderer!.root.findByType("img").props.onLoad());
    const image = renderer!.root.findByType("img");
    expect(image.props.src).toBe(context.repositoryUrl + imagePath);
    expect(image.props.style.maxWidth).toBe("min(100%, 30rem, 120px)");
  });

  it.each([`![clip](${videoPath})`, `<video src="${videoPath}"></video>`])(
    "retries with a new signed video URL and preserves timestamps: %s",
    async (text) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      await act(async () => {
        renderer = create(view(text));
      });
      expect(renderer!.root.findByType("video").props.src).toBe(state.url + "#t=2");
      await act(async () => renderer!.root.findByType("video").props.onError());
      expect(renderer!.root.findByType("video").props.src).toBe(context.repositoryUrl + videoPath);
      await act(async () => renderer!.root.findByType("video").props.onError());
      expect(renderer!.root.findAllByType("video")).toHaveLength(0);
      const retry = renderer!.root
        .findAllByType("button")
        .find(
          (button) => button.findAll((node) => node.children.includes("Retry video")).length > 0,
        );
      expect(retry).toBeDefined();
      await act(async () => retry!.props.onClick());
      expect(renderer!.root.findByType("video").props.src).toBe(
        "https://t3.test/api/assets/refreshed/image#t=2",
      );
    },
  );

  it("leaves ordinary chat uploads outside GitLab MR handling", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          cwd="/worktree"
          environmentId={environmentId}
          text={`![shot](${imagePath})`}
        />,
      );
    });
    expect(renderer!.root.findAllByType("img")).toHaveLength(0);
    expect(renderer!.root.findAllByType("video")).toHaveLength(0);
  });
});
