// @vitest-environment jsdom

import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  RepositoryIdentity,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

const state = vi.hoisted(() => ({
  supported: true,
  resolve: vi.fn(),
  openExternal: vi.fn(),
  toast: vi.fn(),
  toastClose: vi.fn(),
  navigate: vi.fn(),
  openPreview: vi.fn(),
  previewGrant: false,
  shell: { projectId: "project-a" },
  shellListeners: new Set<() => void>(),
  identity: {
    provider: "forgejo",
    canonicalKey: "git.acme.test/team/repo",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://fake-token@git.acme.test:8443/team/repo.git",
    },
    webUrl: undefined as string | undefined,
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => state.previewGrant,
  useEnvironmentScope: () => false,
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../state/entities", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    readEnvironmentSupportsServerBrowser: () => false,
    readThreadShell: () => state.shell,
    useThreadShell: () =>
      useSyncExternalStore(
        (listener) => {
          state.shellListeners.add(listener);
          return () => state.shellListeners.delete(listener);
        },
        () => state.shell,
      ),
    useProjects: () => [
      {
        environmentId: "env-a",
        repositoryIdentity: state.identity,
      },
    ],
    useServerConfigs: () =>
      new Map([
        ["env-a", { environment: { capabilities: { issues: state.supported } } }],
        ["env-b", { environment: { capabilities: { issues: state.supported } } }],
      ]),
  };
});
vi.mock("../state/issues", () => ({ issueEnvironment: { resolveUrl: "resolveUrl" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "resolveUrl" ? state.resolve : state.openPreview,
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
  ensureLocalApi: () => {
    throw new Error("Settings storage is unavailable.");
  },
}));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: state.toast, close: state.toastClose },
}));
import {
  ISSUES_PANEL_REF,
  PULL_REQUESTS_PANEL_REF,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "../hooks/useSettings";
import { PullRequestCommentBody } from "../components/pullRequest/PullRequestCommentBody";
import { PullRequestMarkdown } from "../components/pullRequest/PullRequestMarkdown";
import ChatMarkdown from "../components/ChatMarkdown";
import { useOpenIssueLink } from "./openIssueLink";

const decodeRepositoryIdentity = Schema.decodeSync(RepositoryIdentity);
const threadRef = { environmentId: EnvironmentId.make("env-a"), threadId: ThreadId.make("thread") };
const target = {
  projectId: ProjectId.make("native-project"),
  tracker: IssueTrackerKind.make("linear"),
  host: "linear.app",
  scope: "workspace/ENG",
  key: "ENG-42",
  writable: true,
};
let renderer: ReactTestRenderer;
let open: ReturnType<typeof useOpenIssueLink>;
let standalone = false;

function Hook() {
  const handler = useOpenIssueLink(
    standalone ? undefined : threadRef,
    standalone ? PULL_REQUESTS_PANEL_REF : undefined,
  );
  useEffect(() => {
    open = handler;
  }, [handler]);
  return null;
}

const surfaces = (ref: ScopedThreadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces;

beforeEach(async () => {
  vi.clearAllMocks();
  useRightPanelStore.setState({ byThreadKey: {} });
  standalone = false;
  state.supported = true;
  state.previewGrant = false;
  state.shell = { projectId: "project-a" };
  state.identity = {
    ...state.identity,
    canonicalKey: "git.acme.test/team/repo",
    locator: {
      ...state.identity.locator,
      remoteUrl: "https://fake-token@git.acme.test:8443/team/repo.git",
    },
    webUrl: undefined,
  };
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  state.resolve.mockResolvedValue({ _tag: "Success", value: target });
  state.openExternal.mockResolvedValue(undefined);
  await act(async () => {
    renderer = create(createElement(Hook));
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const event = (patch = {}) => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

describe("native chat issue links", () => {
  it.each(["not a URL", "ssh://ssh.acme.test/team/repo"])(
    "keeps the legacy HTTPS authority when a resolved web URL is unusable (%s)",
    async (webUrl) => {
      state.identity = { ...state.identity, webUrl };
      await act(async () => renderer.update(createElement(Hook)));
      await act(async () =>
        expect(open(event(), "https://git.acme.test:8443/team/repo/issues/42")).toBe(true),
      );
      expect(state.resolve).toHaveBeenCalledOnce();
    },
  );
  it.each(["team/repo", "Root/Mount/Team/Repo"])(
    "recognizes the resolved Forgejo web authority for an SSH identity (%s)",
    async (scope) => {
      const webUrl = `https://git.acme.test:8443/${scope}`;
      const identity = decodeRepositoryIdentity({
        ...state.identity,
        canonicalKey: "ssh.acme.test/team/repo",
        locator: { ...state.identity.locator, remoteUrl: "git@ssh.acme.test:team/repo.git" },
        webUrl,
      });
      state.identity = { ...identity, provider: "forgejo", webUrl: identity.webUrl };
      const resolved = {
        ...target,
        tracker: IssueTrackerKind.make("forgejo"),
        host: "git.acme.test:8443",
        scope,
        key: "42",
      };
      state.resolve.mockResolvedValue({ _tag: "Success", value: resolved });
      await act(async () => renderer.update(createElement(Hook)));
      const url = `${webUrl}/issues/42`;
      await act(async () => expect(open(event(), url)).toBe(true));
      expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: { url, projectId: "project-a" },
      });
      expect(surfaces(threadRef)).toMatchObject([
        { tracker: "forgejo", host: resolved.host, scope, key: "42", url },
      ]);
      state.resolve.mockClear();
      for (const [outside, environmentId] of [
        ["https://git.acme.test:9443/team/repo/issues/42", threadRef.environmentId],
        ["https://unrelated.example/team/repo/issues/42", threadRef.environmentId],
        [`${webUrl}/docs/42`, threadRef.environmentId],
        [url, EnvironmentId.make("env-b")],
      ] as const) {
        const click = event();
        expect(open(click, outside, environmentId)).toBe(false);
        expect(click.preventDefault).not.toHaveBeenCalled();
      }
      expect(state.resolve).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://linear.app/workspace/issue/ENG-42/name",
    "https://acme.atlassian.net/browse/ENG-42",
    "https://git.acme.test:8443/team/repo/issues/42",
    "https://dev.azure.com/acme/Project/_workitems/edit/42",
  ])("asks the server once for %s and opens its native identity", async (url) => {
    const click = event();
    await act(async () => {
      expect(open(click, url)).toBe(true);
    });
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: { url, projectId: "project-a" },
    });
    expect(surfaces(threadRef)).toMatchObject([
      {
        kind: "issue",
        projectId: target.projectId,
        tracker: target.tracker,
        host: target.host,
        scope: target.scope,
        key: target.key,
        url,
      },
    ]);
    expect(state.openExternal).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("opens a thread-less panel link in the issues page's own panel", async () => {
    standalone = true;
    await act(async () => {
      renderer.update(createElement(Hook));
    });
    const url = "https://linear.app/workspace/issue/ENG-42";
    await act(async () => {
      expect(open(event(), url, EnvironmentId.make("env-b"))).toBe(true);
    });
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-b",
      input: { url },
    });
    expect(surfaces(PULL_REQUESTS_PANEL_REF)).toEqual([]);
    expect(surfaces(ISSUES_PANEL_REF)).toMatchObject([
      {
        kind: "issue",
        environmentId: "env-b",
        projectId: target.projectId,
        tracker: target.tracker,
        host: target.host,
        scope: target.scope,
        key: target.key,
        url,
      },
    ]);
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/issues",
      search: {
        who: "all",
        status: "open",
        selectedEnvironmentId: "env-b",
        selectedProjectId: target.projectId,
        selectedHost: target.host,
        tracker: target.tracker,
        scope: target.scope,
        key: target.key,
      },
    });
  });

  it("keeps a thread-less link the server rejects on the external path", async () => {
    vi.stubGlobal("desktopBridge", {});
    standalone = true;
    await act(async () => {
      renderer.update(createElement(Hook));
    });
    state.resolve.mockResolvedValue({ _tag: "Failure" });
    const url = "https://linear.app/workspace/issue/ENG-42";
    await act(async () => {
      open(event(), url, EnvironmentId.make("env-b"));
    });
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(surfaces(ISSUES_PANEL_REF)).toEqual([]);
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("uses the explicit environment without lending another server's project", async () => {
    await act(async () => {
      open(event(), "https://linear.app/workspace/issue/ENG-42", EnvironmentId.make("env-b"));
    });
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-b",
      input: { url: "https://linear.app/workspace/issue/ENG-42" },
    });
    expect(surfaces(threadRef)).toMatchObject([{ environmentId: "env-b" }]);
  });

  it("keeps a rejected or excluded URL usable through the native external-link service", async () => {
    vi.stubGlobal("desktopBridge", {});
    state.resolve.mockResolvedValue({ _tag: "Failure" });
    const url = "https://forgejo.not-owned.test/team/repo/issues/42";
    await act(async () => {
      open(event(), url);
    });
    expect(state.resolve).toHaveBeenCalledOnce();
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(surfaces(threadRef)).toEqual([]);
  });

  it("offers a desktop link the shell could not open as a fresh click", async () => {
    vi.stubGlobal("desktopBridge", {});
    state.resolve.mockResolvedValue({ _tag: "Failure" });
    state.openExternal.mockRejectedValueOnce(new Error("Unable to open link."));
    const url = "https://linear.app/workspace/issue/ENG-42";
    await act(async () => {
      open(event(), url);
    });
    const toast = state.toast.mock.calls[0]?.[0];
    expect(toast).toMatchObject({ type: "error", description: url });
    expect(state.toastClose).not.toHaveBeenCalled();
    await act(async () => toast.actionProps.onClick());
    expect(state.openExternal).toHaveBeenLastCalledWith(url);
    expect(state.toastClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["the browser blocks the late tab", () => state.resolve.mockResolvedValue({ _tag: "Failure" })],
    ["the resolver rejects", () => state.resolve.mockRejectedValue(new Error("offline"))],
  ])("keeps offering a browser link as a fresh click when %s", async (_, fail) => {
    fail();
    const tab = { opener: window, location: { href: "" } };
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const url = "https://linear.app/workspace/issue/ENG-42";
    await act(async () => {
      open(event(), url);
    });
    const toast = state.toast.mock.calls[0]?.[0];
    expect(toast).toMatchObject({ type: "error", description: url });
    const blockedCalls = windowOpen.mock.calls.length;
    toast.actionProps.onClick();
    expect(windowOpen).toHaveBeenCalledTimes(blockedCalls + 1);
    await act(async () => {});
    expect(state.toastClose).not.toHaveBeenCalled();
    windowOpen.mockReturnValue(tab as unknown as Window);
    toast.actionProps.onClick();
    expect(windowOpen).toHaveBeenCalledTimes(blockedCalls + 2);
    await act(async () => {});
    expect(tab).toEqual({ opener: null, location: { href: url } });
    expect(state.toastClose).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledOnce();
    expect(state.openExternal).not.toHaveBeenCalled();
    expect(surfaces(threadRef)).toEqual([]);
  });

  it("opens a blank-first tab in the browser when the server rejects the link in time", async () => {
    state.resolve.mockResolvedValue({ _tag: "Failure" });
    const tab = { opener: window, location: { href: "" } };
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const url = "https://linear.app/workspace/issue/ENG-42";
    await act(async () => {
      open(event(), url);
    });
    expect(windowOpen).toHaveBeenCalledExactlyOnceWith("", "_blank");
    expect(tab).toEqual({ opener: null, location: { href: url } });
    expect(state.openExternal).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });

  describe("when the server rejects the link and links open in the app", () => {
    const url = "https://linear.app/workspace/issue/ENG-42";
    beforeEach(() => {
      vi.stubGlobal("desktopBridge", { preview: {} });
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, browserLinkTarget: "app" });
      state.previewGrant = true;
      state.resolve.mockResolvedValue({ _tag: "Failure" });
    });

    it("opens the link in the thread's in-app browser", async () => {
      state.openPreview.mockResolvedValue(
        AsyncResult.success({
          threadId: threadRef.threadId,
          tabId: "tab-issue",
          navStatus: { _tag: "Loading", url, title: "" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-10-15T00:00:00.000Z",
        }),
      );
      await act(async () => {
        open(event(), url);
      });
      expect(state.resolve).toHaveBeenCalledOnce();
      expect(state.openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: expect.objectContaining({ threadId: threadRef.threadId, url }),
      });
      expect(surfaces(threadRef)).toMatchObject([{ kind: "preview", resourceId: "tab-issue" }]);
      expect(state.openExternal).not.toHaveBeenCalled();
      expect(state.toast).not.toHaveBeenCalled();
    });

    it.each([
      ["the preview grant is missing", () => (state.previewGrant = false)],
      [
        "the in-app browser fails",
        () => state.openPreview.mockResolvedValue(AsyncResult.failure(Cause.fail("offline"))),
      ],
    ])("opens the system browser once when %s", async (_, fail) => {
      fail();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await act(async () => {
        open(event(), url);
      });
      expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
      expect(state.toast).not.toHaveBeenCalled();
    });

    it("opens nothing when the saved setting cannot be read", async () => {
      __resetClientSettingsPersistenceForTests();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const windowOpen = vi.spyOn(window, "open");
      await act(async () => {
        open(event(), url);
      });
      expect(state.toast).toHaveBeenCalledOnce();
      expect(state.openPreview).not.toHaveBeenCalled();
      expect(state.openExternal).not.toHaveBeenCalled();
      expect(windowOpen).not.toHaveBeenCalled();
      expect(state.resolve).toHaveBeenCalledOnce();
    });
  });

  it("reads the thread's project on click without re-parsing mounted markdown on shell updates", async () => {
    const url = "https://linear.app/workspace/issue/ENG-42";
    const parses = vi.fn();
    const countParses = [() => parses];
    let body!: ReactTestRenderer;
    await act(async () => {
      body = create(
        createElement(ChatMarkdown, {
          text: `[ENG-42](${url})`,
          cwd: "/repo",
          threadRef,
          extraRemarkPlugins: countParses,
        }),
      );
    });
    const mounted = parses.mock.calls.length;
    await act(async () => {
      state.shell = { projectId: "project-b" };
      for (const listener of state.shellListeners) listener();
    });
    expect(parses).toHaveBeenCalledTimes(mounted);
    const link = body.root.findAll((node) => node.type === "a" && node.props.href === url)[0]!;
    await act(async () => link.props.onClick(event()));
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: { url, projectId: "project-b" },
    });
    await act(async () => body.unmount());
  });

  it("does not open an issue before a delayed resolver answer", async () => {
    let resolve!: (value: unknown) => void;
    state.resolve.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => {
      open(event(), "https://linear.app/workspace/issue/ENG-42");
    });
    expect(surfaces(threadRef)).toEqual([]);
    await act(async () => {
      resolve({ _tag: "Success", value: target });
    });
    expect(surfaces(threadRef)).toHaveLength(1);
    expect(state.resolve).toHaveBeenCalledOnce();
  });

  it("leaves ordinary documentation links on the existing path without an issue RPC", () => {
    const click = event();
    expect(open(click, "https://linear.app/docs/api")).toBe(false);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });

  it.each(["metaKey", "ctrlKey", "altKey", "shiftKey"])("keeps %s clicks native", async (key) => {
    const click = event({ [key]: true });
    await act(async () => {
      expect(open(click, "https://linear.app/workspace/issue/ENG-42")).toBe(false);
    });
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("keeps unsupported environments on the existing external path", async () => {
    state.supported = false;
    await act(async () => {
      renderer.update(createElement(Hook));
    });
    const click = event();
    expect(open(click, "https://linear.app/workspace/issue/ENG-42")).toBe(false);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });
});

it.each([PullRequestMarkdown, PullRequestCommentBody])(
  "opens an issue link in a standalone %o body on the issues page",
  async (Body) => {
    const url = "https://linear.app/workspace/issue/ENG-42";
    let body!: ReactTestRenderer;
    await act(async () => {
      body = create(
        createElement(Body, {
          text: `[ENG-42](${url})`,
          cwd: "/repo",
          environmentId: EnvironmentId.make("env-b"),
        }),
      );
    });
    const link = body.root.findAll((node) => node.type === "a" && node.props.href === url)[0]!;
    await act(async () => {
      link.props.onClick(event());
    });
    expect(surfaces(ISSUES_PANEL_REF)).toMatchObject([{ environmentId: "env-b", key: "ENG-42" }]);
    expect(surfaces(PULL_REQUESTS_PANEL_REF)).toEqual([]);
    expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/issues" }));
    await act(async () => body.unmount());
  },
);
