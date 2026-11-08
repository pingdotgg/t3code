import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const environmentId = EnvironmentId.make("local");
const state = vi.hoisted(() => ({ reads: [] as unknown[] }));
const project = vi.hoisted(() => ({
  id: "project",
  environmentId: "local",
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
}));
const link = vi.hoisted((): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "Effect-TS/effect",
  number: 7,
  url: "https://github.com/Effect-TS/effect/pull/7",
  source: "manual",
  linkedAt: "2026-09-09T10:00:00Z",
  snapshot: null,
  stack: null,
}));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  readProjects: () => [project],
  useProjects: () => [project],
  useThreadShell: () => ({ projectId: "project", pullRequests: [link] }),
  useServerConfigs: () => new Map([["local", { environment: { capabilities: {} } }]]),
}));
vi.mock("~/state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original<typeof import("~/state/server")>()),
    environmentServerConfigsAtom: Atom.make(new Map([["local", {}]])),
  };
});
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      detail: ((target: unknown) => ({ detail: target })) as never,
      activity: ((target: unknown) => ({ activity: target })) as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => {
    if (atom !== null && typeof atom === "object" && "detail" in atom) state.reads.push(atom);
    return { data: null, isPending: false, error: null, refresh: () => undefined };
  }) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ThreadPullRequestsPanel } from "./ThreadPullRequestsPanel";

it("reads a linked pull request's panel once the pointer rests on its row", async () => {
  state.reads = [];
  await using screen = await render(
    <AppAtomRegistryProvider>
      <ThreadPullRequestsPanel threadRef={scopeThreadRef(environmentId, ThreadId.make("thread"))} />
    </AppAtomRegistryProvider>,
  );
  using _timers = fakeTimers({ now: 0 });
  const row = screen.getByRole("link", { name: /#7/ });
  await expect.element(row).toBeVisible();
  expect(state.reads).toEqual([]);

  await userEvent.hover(row);
  await act(() => vi.advanceTimersByTime(150));
  // The key a click on the link opens the panel with.
  expect(state.reads).toContainEqual({
    detail: {
      environmentId,
      input: {
        projectId: "project",
        // A click resolves the link's URL, which names the repository in lower case.
        repository: "effect-ts/effect",
        number: 7,
        host: "github.com",
        allowStale: false,
      },
    },
  });
});
