import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { PULL_REQUESTS_PANEL_REF } from "../rightPanelStore";
import { useOpenChangeRequestLink } from "./openPullRequestLink";

const { navigate, openPullRequest } = vi.hoisted(() => ({
  navigate: vi.fn(),
  openPullRequest: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../state/entities", () => ({
  useProjects: () => [
    {
      id: "project",
      environmentId: "local",
      repositoryIdentity: {
        provider: "github",
        canonicalKey: "github.com/acme/app",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/app.git",
        },
      },
    },
  ],
  useServerConfigs: () =>
    new Map([
      [
        "local",
        { environment: { capabilities: { pullRequests: true, threadPullRequests: true } } },
      ],
    ]),
}));
vi.mock("../rightPanelStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rightPanelStore")>()),
  useRightPanelStore: { getState: () => ({ openPullRequest }) },
}));

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function Link({ panelRef, threadRef }: { panelRef: ScopedThreadRef; threadRef?: ScopedThreadRef }) {
  const open = useOpenChangeRequestLink(threadRef, panelRef);
  return (
    <button
      onClick={() =>
        open(
          { preventDefault: vi.fn(), stopPropagation: vi.fn(), metaKey: false, ctrlKey: false },
          "https://github.com/acme/app/pull/7",
        )
      }
    >
      Open
    </button>
  );
}

it.each(["issues", "pull-requests", "thread"])(
  "opens links in the owning %s panel",
  async (surface) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const panelRef =
      surface === "pull-requests"
        ? PULL_REQUESTS_PANEL_REF
        : scopeThreadRef(
            EnvironmentId.make("local"),
            ThreadId.make(surface === "issues" ? "issues-panel" : "thread"),
          );
    await act(() => {
      renderer = create(
        <Link panelRef={panelRef} {...(surface === "thread" ? { threadRef: panelRef } : {})} />,
      );
    });
    await act(() => renderer.root.findByType("button").props.onClick());
    expect(openPullRequest).toHaveBeenCalledWith(
      panelRef,
      expect.objectContaining({ projectId: "project", repository: "acme/app", number: 7 }),
    );
    if (surface === "pull-requests")
      expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/pull-requests" }));
    else expect(navigate).not.toHaveBeenCalled();
  },
);
