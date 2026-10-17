// @vitest-environment jsdom

import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
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
  editing: false,
  permission: {},
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
vi.mock("@effect/atom-react", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  const derived = new Set(["markdown-server-config-fields", "pull-request-link-mode"]);
  return {
    useAtomValue: (atom: { readonly label?: readonly [string, ...unknown[]] }) =>
      atom === state.permission
        ? state.editing
        : derived.has(atom.label?.[0] ?? "")
          ? registry.get(atom as never)
          : null,
  };
});
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    serverEnvironment: { configValueAtom: () => noConfig },
    environmentServerConfigsAtom: Atom.make(
      () =>
        new Map(
          ["env-a", "env-b"].map((id) => [
            id,
            { environment: { capabilities: { issues: state.supported } } },
          ]),
        ),
    ),
  };
});
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
vi.mock("../state/issues", () => ({
  issueEnvironment: {
    resolveUrl: "resolveUrl",
    editComment: { permissionAtom: () => state.permission },
  },
}));
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
import { IssueCommentContent } from "../components/issue/IssueConversation";
import { writeIssueListPreferences } from "../components/issue/issueListPreferences";
import { useOpenIssueLink, type IssueLinkContext } from "./openIssueLink";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";

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
let linkContext: IssueLinkContext | undefined;

function Hook() {
  const handler = useOpenIssueLink(
    standalone ? undefined : threadRef,
    standalone ? PULL_REQUESTS_PANEL_REF : undefined,
    linkContext,
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
  linkContext = undefined;
  state.editing = false;
  localStorage.clear();
  state.supported = true;
  appAtomRegistry.refresh(environmentServerConfigsAtom);
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
  it("reads revoked and restored issue support at click time without a new handler", async () => {
    const handler = open;
    const url = "https://linear.app/workspace/issue/ENG-42";
    state.supported = false;
    appAtomRegistry.refresh(environmentServerConfigsAtom);
    const click = event();
    expect(handler(click, url)).toBe(false);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
    state.supported = true;
    appAtomRegistry.refresh(environmentServerConfigsAtom);
    await act(async () => expect(handler(event(), url)).toBe(true));
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: { url, projectId: "project-a" },
    });
    expect(open).toBe(handler);
  });
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

  it("retains the resolved account in the standalone tab and URL without changing list preferences", async () => {
    standalone = true;
    writeIssueListPreferences({ who: "all", status: "open", connectionId: "list-account" });
    state.resolve.mockResolvedValue({
      _tag: "Success",
      value: { ...target, connectionId: "Account/B" },
    });
    await act(async () => renderer.update(createElement(Hook)));
    await act(async () => {
      open(event(), "https://linear.app/workspace/issue/ENG-42", EnvironmentId.make("env-b"));
    });
    expect(surfaces(ISSUES_PANEL_REF)).toMatchObject([{ connectionId: "Account/B" }]);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/issues",
      search: expect.objectContaining({
        connectionId: "list-account",
        selectedConnectionId: "Account/B",
      }),
    });
  });

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
    writeIssueListPreferences({
      who: "all",
      status: "open",
      issueSort: "created",
      issueOrder: "asc",
    });
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
        issueSort: "created",
        issueOrder: "asc",
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

  it.each([false, true])(
    "keeps the current issue account and source project (standalone=%s)",
    async (isStandalone) => {
      standalone = isStandalone;
      state.resolve.mockImplementation(async ({ input }) => ({
        _tag: "Success",
        value: { ...target, connectionId: input.connectionId },
      }));
      for (const connectionId of ["Account/A", "Account/B", undefined]) {
        state.resolve.mockClear();
        linkContext = {
          environmentId: threadRef.environmentId,
          projectId: ProjectId.make("source-project"),
          tracker: target.tracker,
          host: target.host,
          connectionId,
        };
        await act(async () => renderer.update(createElement(Hook)));
        await act(async () => {
          open(event(), "https://linear.app/workspace/issue/ENG-42");
        });
        expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
          environmentId: "env-a",
          input: {
            url: "https://linear.app/workspace/issue/ENG-42",
            projectId: "source-project",
            ...(connectionId === undefined ? {} : { connectionId }),
          },
        });
        expect(
          surfaces(isStandalone ? ISSUES_PANEL_REF : threadRef).some(
            (surface) => surface.kind === "issue" && surface.connectionId === connectionId,
          ),
        ).toBe(true);
      }
    },
  );

  it.each([
    ["linear", "linear.app", "https://github.com/acme/web/issues/42"],
    ["github", "git.example", "https://git.example/team/repo/-/issues/42"],
    ["forgejo", "forgejo.one.test", "https://forgejo.two.test/team/repo/issues/42"],
    ["forgejo", "forgejo.one.test:8443", "https://forgejo.one.test:9443/team/repo/issues/42"],
  ])(
    "keeps the project hint without lending %s account on %s to %s",
    async (tracker, host, url) => {
      linkContext = {
        environmentId: threadRef.environmentId,
        projectId: ProjectId.make("source-project"),
        tracker: IssueTrackerKind.make(tracker),
        host,
        connectionId: "Account/B",
      };
      await act(async () => renderer.update(createElement(Hook)));
      await act(async () => {
        open(event(), url);
      });
      expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
        environmentId: "env-a",
        input: { url, projectId: "source-project" },
      });
      expect(surfaces(threadRef)).toHaveLength(1);
      expect(state.openExternal).not.toHaveBeenCalled();
    },
  );

  it("keeps the account of a configured Jira mount and rejects a different mount", async () => {
    linkContext = {
      environmentId: threadRef.environmentId,
      projectId: ProjectId.make("source-project"),
      tracker: IssueTrackerKind.make("jira"),
      host: "jira.example.test:8443/Jira",
      connectionId: "Account/B",
    };
    await act(async () => renderer.update(createElement(Hook)));
    const url = "https://jira.example.test:8443/Jira/browse/ENG-42";
    await act(async () => expect(open(event(), url)).toBe(true));
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-a",
      input: { url, projectId: "source-project", connectionId: "Account/B" },
    });
    state.resolve.mockClear();
    expect(open(event(), "https://jira.example.test:8443/jira/browse/ENG-42")).toBe(false);
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("does not lend the issue's local project or account to another environment", async () => {
    linkContext = {
      environmentId: threadRef.environmentId,
      projectId: ProjectId.make("source-project"),
      tracker: target.tracker,
      host: target.host,
      connectionId: "Account/B",
    };
    await act(async () => renderer.update(createElement(Hook)));
    await act(async () => {
      open(event(), "https://linear.app/workspace/issue/ENG-42", EnvironmentId.make("env-b"));
    });
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-b",
      input: { url: "https://linear.app/workspace/issue/ENG-42" },
    });
  });

  it("does not retry a refused explicit account through the default account", async () => {
    vi.stubGlobal("desktopBridge", {});
    linkContext = {
      environmentId: threadRef.environmentId,
      projectId: ProjectId.make("source-project"),
      tracker: target.tracker,
      host: target.host,
      connectionId: "Account/B",
    };
    state.resolve.mockResolvedValue({ _tag: "Failure" });
    await act(async () => renderer.update(createElement(Hook)));
    const url = "https://linear.app/workspace/issue/ENG-42";
    await act(async () => {
      open(event(), url);
    });
    expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-a",
      input: { url, projectId: "source-project", connectionId: "Account/B" },
    });
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(surfaces(threadRef)).toEqual([]);
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
    expect(mounted).toBe(1);
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
    appAtomRegistry.refresh(environmentServerConfigsAtom);
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

it.each(
  [false, true].flatMap((previewing) =>
    [false, true].flatMap((isStandalone) =>
      [false, true].map((crossTracker) => ({ previewing, isStandalone, crossTracker })),
    ),
  ),
)(
  "scopes the account in a comment link (preview=$previewing, standalone=$isStandalone, crossTracker=$crossTracker)",
  async ({ previewing, isStandalone, crossTracker }) => {
    state.editing = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const url = crossTracker
      ? "https://github.com/acme/web/issues/42"
      : "https://linear.app/workspace/issue/ENG-42";
    const resolved = crossTracker
      ? {
          ...target,
          tracker: IssueTrackerKind.make("github"),
          host: "github.com",
          scope: "acme/web",
          key: "42",
        }
      : { ...target, connectionId: "Account/B" };
    state.resolve.mockResolvedValue({ _tag: "Success", value: resolved });
    try {
      await act(async () =>
        root.render(
          createElement(IssueCommentContent, {
            environmentId: threadRef.environmentId,
            reference: { ...target, connectionId: "Account/B" },
            comment: {
              id: "comment",
              body: `[ENG-42](${url})`,
              author: null,
              createdAt: "2026-10-14T00:00:00Z",
              url: null,
              canEdit: true,
            },
            canEdit: true,
            cwd: "/repo",
            threadRef: isStandalone ? null : threadRef,
          }),
        ),
      );
      if (previewing) {
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!.click(),
        );
        const preview = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Preview",
        )!;
        await act(async () => preview.click());
      }
      await act(async () =>
        container.querySelector<HTMLAnchorElement>(`a[href="${url}"]`)!.click(),
      );
      expect(surfaces(isStandalone ? ISSUES_PANEL_REF : threadRef)).toMatchObject([
        {
          tracker: resolved.tracker,
          key: resolved.key,
          ...(crossTracker ? {} : { connectionId: "Account/B" }),
        },
      ]);
      expect(state.resolve).toHaveBeenCalledExactlyOnceWith({
        environmentId: "env-a",
        input: {
          url,
          projectId: target.projectId,
          ...(crossTracker ? {} : { connectionId: "Account/B" }),
        },
      });
      if (!isStandalone) {
        expect(surfaces(ISSUES_PANEL_REF)).toEqual([]);
        expect(state.navigate).not.toHaveBeenCalled();
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
