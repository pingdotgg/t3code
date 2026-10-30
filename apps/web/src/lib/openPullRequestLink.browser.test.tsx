import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({ preview: vi.fn(), openLink: vi.fn() }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.preview }));
vi.mock("../browser/useOpenLink", () => ({ useOpenLink: () => state.openLink }));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readProjects: () => [project],
  useProjects: () => [project],
  readProject: () => project,
  readThreadShell: () => ({ projectId: "project", worktreePath: null }),
}));
vi.mock("../state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original<typeof import("../state/server")>()),
    environmentServerConfigsAtom: Atom.make(new Map([["local", {}]])),
  };
});

import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { __setClientSettingsForTests } from "../hooks/useSettings";
import { ToastProvider } from "../components/ui/toast";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { useRightPanelStore } from "../rightPanelStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { useOpenChangeRequestLink } from "./openPullRequestLink";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const project = {
  id: "project",
  environmentId,
  workspaceRoot: "/repo",
  repositoryIdentity: {
    provider: "github",
    canonicalKey: "github.com/effect-ts/effect",
    displayName: "Effect-TS/effect",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/Effect-TS/effect.git",
    },
  },
};
const commitUrl = `https://github.com/Effect-TS/effect/commit/${"a".repeat(40)}?plain=1#diff-original`;
const pullRequestCommitUrl = `https://github.com/Effect-TS/effect/pull/1/commits/${"a".repeat(40)}`;

function CommitLink({ url = commitUrl }: { url?: string }) {
  const open = useOpenChangeRequestLink(threadRef);
  return (
    <a href={url} onClick={(event) => open(event, url)}>
      Commit
    </a>
  );
}

function setup() {
  state.preview.mockReset().mockResolvedValue(AsyncResult.success({ sources: [] }));
  state.openLink.mockReset().mockResolvedValue(undefined);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    pullRequestLinksOpenInApp: true,
    browserLinkTarget: "system",
  });
  useDiffPanelStore.setState({
    byThreadKey: {},
    branchBaseRefByThreadKey: {},
    keepSelectionOnOpenThreadKey: null,
  });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
}

it.each([
  ["shiftKey", commitUrl],
  ["altKey", commitUrl],
  ["shiftKey", pullRequestCommitUrl],
] as const)("keeps %s clicks on %s native", async (modifier, url) => {
  setup();
  await using screen = await render(
    <AppAtomRegistryProvider>
      <CommitLink url={url} />
    </AppAtomRegistryProvider>,
  );
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true });
  const defaults: boolean[] = [];
  screen.container.addEventListener(
    "click",
    (nativeEvent) => {
      defaults.push(nativeEvent.defaultPrevented);
      nativeEvent.preventDefault();
    },
    { once: true },
  );
  await act(() => screen.getByRole("link", { name: "Commit" }).element().dispatchEvent(event));
  expect(defaults).toEqual([false]);
  expect(state.preview).not.toHaveBeenCalled();
  expect(useRightPanelStore.getState().byThreadKey).toEqual({});
});

it.each(["system", "app"] as const)(
  "offers the original unavailable commit URL when web popups are blocked (%s)",
  async (browserLinkTarget) => {
    setup();
    // Without preview access, the "app" preference opens a popup too.
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      pullRequestLinksOpenInApp: true,
      browserLinkTarget,
    });
    using _desktop = stubGlobal("desktopBridge", undefined);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <ToastProvider>
          <CommitLink />
        </ToastProvider>
      </AppAtomRegistryProvider>,
    );
    using open = vi.spyOn(window, "open").mockReturnValue(null);
    await screen.getByRole("link", { name: "Commit" }).click();
    await expect
      .element(page.getByRole("button", { name: "Open link", exact: true }))
      .toBeVisible();
    expect(open).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Open link", exact: true }).click();
    expect(open).toHaveBeenCalledExactlyOnceWith(commitUrl, "_blank", "noopener,noreferrer");
    expect(state.openLink).not.toHaveBeenCalled();
  },
);

it("opens an available commit in the closed Diff pane without the pane resetting it", async () => {
  setup();
  const sha = "a".repeat(40);
  state.preview.mockResolvedValue(
    AsyncResult.success({ sources: [{ kind: "commit", headRef: sha }] }),
  );
  await using screen = await render(
    <AppAtomRegistryProvider>
      <CommitLink />
    </AppAtomRegistryProvider>,
  );
  await screen.getByRole("link", { name: "Commit" }).click();
  await vi.waitFor(() =>
    expect(useDiffPanelStore.getState().byThreadKey).toEqual({
      [scopedThreadKey(threadRef)]: { kind: "commit", sha, baseRef: null },
    }),
  );
  // ChatView resets a pane opened without an explicit request to Changes unless this is set.
  expect(useDiffPanelStore.getState().consumeKeepSelectionOnOpen(threadRef)).toBe(true);
});
