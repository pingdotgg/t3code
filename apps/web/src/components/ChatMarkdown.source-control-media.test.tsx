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
    useAssetUrlRefresh: () => async () => {},
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

describe("source-control image loading", () => {
  it("recovers from a failed image after its signed URL refreshes and preserves authored layout", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const view = () => (
      <ChatMarkdown
        cwd="/worktree"
        environmentId={environmentId}
        text={
          '<img id="shot" width="120" src="https://github.com/user-attachments/assets/1234-abcd" alt="screenshot">'
        }
      />
    );
    await act(async () => {
      renderer = create(view());
    });
    let image = renderer!.root.findByType("img");
    expect(image.props.src).toBe(state.url);
    await act(async () => image.props.onError());
    await act(async () => renderer!.root.findByType("img").props.onError());
    expect(renderer!.root.findAllByType("img")).toHaveLength(0);
    state.url = "https://t3.test/api/assets/refreshed/image";
    await act(async () => state.refresh());
    image = renderer!.root.findByType("img");
    await act(async () => image.props.onLoad());
    image = renderer!.root.findByType("img");
    expect(image.props.src).toBe(state.url);
    expect(image.props.id).toBe("user-content-shot");
    expect(image.props.style.maxWidth).toBe("min(100%, 30rem, 120px)");
  });

  it.each([
    "https://github.com/user-attachments/assets/1234-abcd",
    "https://git.example/acme/project/uploads/e347d7ff85358d19b72222f1174b9a4b/shot.png",
  ])("renders a public image through an older environment's fallback: %s", async (url) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.failed = true;
    await act(async () => {
      renderer = create(
        <ChatMarkdown cwd="/worktree" environmentId={environmentId} text={`![shot](${url})`} />,
      );
    });
    await act(async () => renderer!.root.findByType("img").props.onLoad());
    expect(renderer!.root.findByType("img").props.src).toBe(url);
  });

  it("loads a public GitLab image after a successful URL grant but failed authenticated request", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const url =
      "https://git.example/acme/project/uploads/e347d7ff85358d19b72222f1174b9a4b/shot.png";
    await act(async () => {
      renderer = create(
        <ChatMarkdown cwd="/worktree" environmentId={environmentId} text={`![shot](${url})`} />,
      );
    });
    expect(renderer!.root.findByType("img").props.src).toBe(state.url);
    await act(async () => renderer!.root.findByType("img").props.onError());
    expect(renderer!.root.findByType("img").props.src).toBe(url);
    await act(async () => renderer!.root.findByType("img").props.onLoad());
    expect(renderer!.root.findByType("img").props.src).toBe(url);
    expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(0);
  });

  it.each([
    "http://gitlab.local/acme/project/uploads/e347d7ff85358d19b72222f1174b9a4b/clip.mp4",
    '<video src="http://gitlab.local/acme/project/uploads/e347d7ff85358d19b72222f1174b9a4b/clip.mp4"></video>',
    "![clip](/uploads/e347d7ff85358d19b72222f1174b9a4b/clip.mp4)",
  ])("uses authenticated playback and retry for GitLab video syntax: %s", async (text) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(
        <PullRequestMarkdownContext
          value={{
            repositoryUrl: null,
            threadRef: null,
            imageContext: {
              provider: "gitlab",
              repositoryUrl: "http://gitlab.local/acme/project",
              host: "gl.here",
            },
          }}
        >
          <PullRequestMarkdown cwd="/worktree" environmentId={environmentId} text={text} />
        </PullRequestMarkdownContext>,
      );
    });
    expect(renderer!.root.findByType("video").props.src).toBe(state.url);
    await act(async () => renderer!.root.findByType("video").props.onError());
    expect(renderer!.root.findAllByType("video")).toHaveLength(0);
    const retry = renderer!.root
      .findAllByType("button")
      .find(
        (node) =>
          node.findAll((n) => n.type === "span" && n.children.includes("Retry video")).length > 0 ||
          node.children.includes("Retry video"),
      );
    expect(retry).toBeDefined();
    await act(async () => retry!.props.onClick());
    expect(renderer!.root.findByType("video").props.src).toBe(state.url);
  });

  it("loads a GitLab MR upload without a thread and retains its failure placeholder", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(
        <PullRequestMarkdownContext
          value={{
            repositoryUrl: null,
            threadRef: null,
            imageContext: { provider: "gitlab", repositoryUrl: "https://git.example/acme/project" },
          }}
        >
          <PullRequestMarkdown
            cwd="/worktree"
            environmentId={environmentId}
            text="![shot](/uploads/e347d7ff85358d19b72222f1174b9a4b/shot.png)"
          />
        </PullRequestMarkdownContext>,
      );
    });
    const image = renderer!.root.findByType("img");
    expect(image.props.src).toBe(state.url);
    await act(async () => image.props.onError());
    await act(async () => renderer!.root.findByType("img").props.onError());
    expect(renderer!.root.findAllByType("img")).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.role === "alert")).not.toHaveLength(0);
  });
});
