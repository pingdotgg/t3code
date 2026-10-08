// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { LinkPullRequestDialogHost, openLinkPullRequestDialog } from "./LinkPullRequestDialog";

const mocks = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<unknown>,
  threadProjectId: "b",
  bindings: {} as Record<string, { repository: string }>,
  update: vi.fn(),
}));
const url = "https://linear.app/workspace-b/issue/ENG-5/title";
vi.mock("~/state/entities", () => ({
  useProjects: () => mocks.projects,
  useServerConfigs: () =>
    new Map([["env", { environment: { capabilities: { issues: true, pullRequests: false } } }]]),
  useThreadShell: () => ({ projectId: mocks.threadProjectId, issues: [] }),
}));
vi.mock("~/hooks/usePullRequestLinking", () => ({
  usePullRequestLinking: () => ({ mode: "unsupported", canLink: () => false }),
}));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => mocks.bindings }));
vi.mock("~/state/queries", () => ({ useDebouncedValue: <A,>(value: A) => value }));
vi.mock("~/state/issues", () => ({ issueEnvironment: { detail: (target: unknown) => target } }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { detail: () => null } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (target: { input: { projectId: string } } | null) => ({
    data:
      target === null
        ? null
        : {
            projectId: target.input.projectId,
            provider: "linear",
            repository: "ENG",
            number: 5,
            url,
            title: `Read through ${target.input.projectId}`,
            state: "open",
          },
    error: null,
    isPending: false,
    isSuccess: target !== null,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function linkLinearIssue() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.update.mockResolvedValue({ _tag: "Success", value: undefined });
  openLinkPullRequestDialog({
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
  });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <AppAtomRegistryProvider>
        <LinkPullRequestDialogHost />
      </AppAtomRegistryProvider>,
    ),
  );
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, url);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const link = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Link",
  )!;
  await act(async () => link.click());
  await act(async () => root.unmount());
  return mocks.update.mock.calls[0]?.[0].input.issueLink.projectId;
}

const project = (id: string, environmentId = "env") => ({ id, environmentId });

describe("LinkPullRequestDialog Linear issues", () => {
  it.each([
    [["a", "b"], "b", "b"],
    [["b", "a"], "b", "b"],
    [["a", "b"], "a", "a"],
    [["b", "a"], "a", "a"],
    [["a", "b", "c"], "c", "a"],
    [["b", "a", "c"], "c", "b"],
  ])("links projects %j from thread project %s through %s", async (order, current, expected) => {
    mocks.projects = [project("b", "other"), ...order.map((id) => project(id))];
    mocks.threadProjectId = current;
    mocks.bindings = {
      a: { repository: "ENG" },
      b: { repository: "eng" },
      c: { repository: "OPS" },
    };
    expect(await linkLinearIssue()).toBe(expected);
  });
});
