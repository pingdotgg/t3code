import { EnvironmentId, ProjectId, type WorkItemLink } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  supported: true,
  queries: [] as unknown[],
  refresh: vi.fn(),
  refreshAtom: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  openLink: vi.fn(),
  data: { links: [] as WorkItemLink[], truncated: false },
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      ["environment-1", { environment: { capabilities: { workItemLinks: state.supported } } }],
    ]),
  useProjects: () => [
    {
      id: "project-1",
      environmentId: "environment-1",
      title: "Frontend",
      repositoryIdentity: { displayName: "acme/frontend" },
    },
    {
      id: "project-2",
      environmentId: "environment-1",
      title: "Backend",
      repositoryIdentity: { displayName: "acme/backend" },
    },
  ],
}));
vi.mock("~/state/workItems", () => ({
  workItemLinks: {
    list: (target: unknown) => {
      state.queries.push(target);
      return target;
    },
    link: "link",
    unlink: "unlink",
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.data,
    error: null,
    isPending: false,
    refresh: state.refresh,
  }),
  formatEnvironmentQueryError: () => "Server rejected link",
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "link" ? state.link : state.unlink),
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: state.refreshAtom } }));
vi.mock("~/lib/openIssueLink", () => ({ openLinkInBrowser: state.openLink }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogPopup: "div",
  DialogHeader: "div",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "div",
  DialogFooter: "div",
}));

import { SavedWorkItemLinks } from "./SavedWorkItemLinks";

const environmentId = EnvironmentId.make("environment-1");
const issue = {
  kind: "issue" as const,
  provider: "linear",
  url: "https://linear.app/acme/issue/ENG-42/broken-flow",
  reference: {
    projectId: ProjectId.make("project-1"),
    provider: "linear",
    repository: "ENG",
    number: 42,
  },
};
const pullRequest = {
  kind: "pull-request" as const,
  provider: "github",
  url: "https://github.com/acme/backend/pull/14",
  reference: { projectId: ProjectId.make("project-2"), repository: "acme/backend", number: 14 },
};
const pair: WorkItemLink = {
  issue: {
    provider: "linear",
    url: "https://linear.app/acme/issue/ENG-42",
    repository: "ENG",
    number: 42,
    title: "Broken flow",
  },
  pullRequest: {
    provider: "github",
    url: pullRequest.url,
    repository: "acme/backend",
    number: 14,
    title: "Repair flow",
  },
};

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.supported = true;
  state.data = { links: [], truncated: false };
  state.queries.length = 0;
  for (const mock of [state.refresh, state.refreshAtom, state.link, state.unlink, state.openLink])
    mock.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function button(label: string) {
  return renderer.root.findAllByType("button").find(
    (entry) =>
      entry.props["aria-label"] === label ||
      entry.children
        .filter((child) => typeof child === "string")
        .join("")
        .includes(label),
  )!;
}

async function openDialog(label: string) {
  await act(() => button(label).props.onClick());
  expect(renderer.root.findAllByType("form")).toHaveLength(1);
}

async function enter(label: string, value: string) {
  const field = renderer.root
    .findAllByType("label")
    .find((entry) =>
      entry.children.some((child) => typeof child === "string" && child.includes(label)),
    )!
    .findByType("input");
  await act(() => field.props.onChange({ target: { value } }));
}

async function submit() {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

it("links a Linear issue to a PR in another project, then refreshes both canonical sources", async () => {
  state.link.mockResolvedValue({ _tag: "Success", value: pair });
  await act(() => {
    renderer = create(<SavedWorkItemLinks environmentId={environmentId} source={issue} />);
  });
  await openDialog("Link pull request");
  await act(() =>
    renderer.root.findByType("select").props.onChange({ target: { value: "project-2" } }),
  );
  await enter("Number", "14");
  await submit();

  expect(state.link).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      issue: issue.reference,
      pullRequest: {
        projectId: pullRequest.reference.projectId,
        repository: "acme/backend",
        number: 14,
      },
    },
  });
  expect(state.refreshAtom.mock.calls.map(([target]) => target.input.source)).toEqual([
    { provider: "linear", url: pair.issue.url },
    { provider: "github", url: pullRequest.url },
  ]);
  expect(state.queries[0]).toMatchObject({
    input: { source: { provider: "linear", url: pair.issue.url } },
  });
  expect(renderer.root.findAllByType("form")).toHaveLength(0);
  state.data = { links: [pair], truncated: false };
  await act(() =>
    renderer.update(<SavedWorkItemLinks environmentId={environmentId} source={issue} />),
  );
  await act(() => button("Repair flow").props.onClick());
  expect(state.openLink).toHaveBeenCalledExactlyOnceWith(pullRequest.url);
  await act(() => button("Refresh saved links").props.onClick());
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("links a PR to a Linear issue, keeps failed input open, and unlinks the canonical pair", async () => {
  state.link
    .mockResolvedValueOnce({ _tag: "Failure", cause: new Error("rejected") })
    .mockResolvedValueOnce({ _tag: "Success", value: pair });
  state.unlink.mockResolvedValue({ _tag: "Success" });
  await act(() => {
    renderer = create(<SavedWorkItemLinks environmentId={environmentId} source={pullRequest} />);
  });
  await openDialog("Link issue");
  await act(() =>
    renderer.root.findByType("select").props.onChange({ target: { value: "project-1" } }),
  );
  await enter("Provider", "linear");
  await enter("Repository or Linear team", "ENG");
  await enter("Number", "42");
  await submit();
  expect(renderer.root.findAllByType("form")).toHaveLength(1);
  expect(renderer.root.findByProps({ role: "alert" }).children).toContain("Server rejected link");
  await submit();
  expect(state.link).toHaveBeenLastCalledWith({
    environmentId,
    input: { issue: issue.reference, pullRequest: pullRequest.reference },
  });
  state.data = { links: [pair], truncated: false };
  await act(() =>
    renderer.update(<SavedWorkItemLinks environmentId={environmentId} source={pullRequest} />),
  );
  await act(async () => button("Unlink Broken flow").props.onClick());
  expect(state.unlink).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      issue: { provider: "linear", url: pair.issue.url },
      pullRequest: { provider: "github", url: pullRequest.url },
    },
  });
  expect(state.refreshAtom).toHaveBeenCalledTimes(4);
});

it("rejects incomplete targets locally and never calls a server without link support", async () => {
  await act(() => {
    renderer = create(<SavedWorkItemLinks environmentId={environmentId} source={pullRequest} />);
  });
  await openDialog("Link issue");
  await submit();
  expect(state.link).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType("form")).toHaveLength(1);
  state.supported = false;
  state.queries.length = 0;
  await act(() =>
    renderer.update(<SavedWorkItemLinks environmentId={environmentId} source={pullRequest} />),
  );
  expect(renderer.root.findAllByType("form")).toHaveLength(0);
  expect(state.queries).toHaveLength(0);
});

it("resets the target project when the same item is opened from another project", async () => {
  await act(() => {
    renderer = create(<SavedWorkItemLinks environmentId={environmentId} source={issue} />);
  });
  await openDialog("Link pull request");
  await act(() =>
    renderer.update(
      <SavedWorkItemLinks
        environmentId={environmentId}
        source={{
          ...issue,
          reference: { ...issue.reference, projectId: ProjectId.make("project-2") },
        }}
      />,
    ),
  );
  await openDialog("Link pull request");
  expect(renderer.root.findByType("select").props.value).toBe("project-2");
  expect(renderer.root.findAllByType("input")[0]!.props.value).toBe("acme/backend");
});
