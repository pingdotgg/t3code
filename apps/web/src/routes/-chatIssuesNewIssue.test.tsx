// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { NewIssueControl } from "./_chat.issues";

const mocks = vi.hoisted(() => ({ allowed: true, createIssue: vi.fn() }));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => mocks.allowed,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [{ id: "p1", repositoryIdentity: { displayName: "acme/web" } }],
}));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({
    data: { templates: [], contactLinks: [], blankIssuesEnabled: true },
    error: null,
    isPending: false,
  }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.createIssue }));

afterEach(() => {
  mocks.allowed = true;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function renderNewIssueControl(onCreated = vi.fn()) {
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
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <NewIssueControl
        environmentId={"local" as EnvironmentId}
        projects={[{ id: "p1" as ProjectId, title: "Web", workspaceRoot: "/w" }]}
        projectId={"p1" as ProjectId}
        onCreated={onCreated}
      />,
    ),
  );
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((element) =>
      element.textContent?.includes(label),
    );
  return { button, unmount: () => act(async () => root.unmount()) };
}

describe("NewIssueControl", () => {
  it("opens the create dialog and files the issue", async () => {
    mocks.createIssue.mockResolvedValue({
      _tag: "Success",
      value: { number: 7, url: "https://github.com/acme/web/issues/7" },
    });
    const onCreated = vi.fn();
    const { button, unmount } = await renderNewIssueControl(onCreated);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => button("New issue")!.click());
    const title = document.querySelector<HTMLInputElement>("#issue-title")!;
    expect(title).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        title,
        "Crash on save",
      );
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Create")!.click());

    expect(mocks.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "local",
        input: expect.objectContaining({
          projectId: "p1",
          repository: "acme/web",
          title: "Crash on save",
        }),
      }),
    );
    expect(onCreated).toHaveBeenCalledWith({
      projectId: "p1",
      repository: "acme/web",
      number: 7,
      url: "https://github.com/acme/web/issues/7",
    });
    await unmount();
  });

  it("keeps the dialog closed for a read-only connection", async () => {
    mocks.allowed = false;
    const { button, unmount } = await renderNewIssueControl();
    const newIssue = button("New issue")!;

    expect(newIssue.disabled).toBe(true);
    await act(async () => newIssue.click());
    expect(document.querySelector("#issue-title")).toBeNull();
    expect(mocks.createIssue).not.toHaveBeenCalled();
    await unmount();
  });
});
