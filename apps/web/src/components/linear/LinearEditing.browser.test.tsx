import { EnvironmentId, type LinearIssueDetail } from "@t3tools/contracts";
import type { ReactNode } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const commands = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("../../state/linear", () => ({
  linearEnvironment: {
    upload: { permissionAtom: () => null },
    documents: () => "documents",
    document: () => "document",
    teamContext: () => "context",
    issue: () => "issue",
    comments: () => null,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data:
      query === "documents"
        ? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
        : query === "context"
          ? { states: [], labels: [], cycles: [], projects: [] }
          : query === "issue"
            ? longIssue
            : null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => commands.upload,
}));
vi.mock("./LinearControls", () => ({
  LinearMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
  LinearMessage: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  LinearPager: () => null,
  LinearSelect: () => null,
}));

import { LinearDocuments } from "./LinearDocuments";
import { LinearIssuePanel } from "./LinearIssuePanel";

const environmentId = EnvironmentId.make("remote");
const workspace = {
  viewer: { id: "viewer", name: "Panos", avatarUrl: null },
  organization: { id: "org", name: "Workspace", urlKey: "workspace" },
  teams: [{ id: "team", name: "Team", key: "TEAM", color: null }],
  users: [],
  projectStatuses: [],
};
const longIssue: LinearIssueDetail = {
  id: "issue",
  identifier: "TEAM-1",
  title: "Task",
  url: "https://linear.app/test/issue/TEAM-1",
  description:
    "x".repeat(
      7999 - "Work on Linear issue TEAM-1: Task\nhttps://linear.app/test/issue/TEAM-1\n\n".length,
    ) + "😀tail",
  branchName: "team-1-task",
  priority: 0,
  priorityLabel: "None",
  updatedAt: "2026-11-08T00:00:00Z",
  dueDate: null,
  estimate: null,
  state: { id: "todo", name: "Todo", color: "#888", type: "unstarted" },
  team: workspace.teams[0]!,
  assignee: null,
  creator: null,
  project: null,
  cycle: null,
  parent: null,
  archivedAt: null,
  labels: { nodes: [] },
  children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  attachments: { nodes: [] },
  relations: { nodes: [] },
  inverseRelations: { nodes: [] },
};
const uploaded = AsyncResult.success({ assetUrl: "https://uploads.linear.app/proof.txt" });
function pendingUpload() {
  let complete!: (result: typeof uploaded) => void;
  commands.upload.mockReset().mockReturnValue(
    new Promise<typeof uploaded>((resolve) => {
      complete = resolve;
    }),
  );
  return () => complete(uploaded);
}

it("does not append a finished upload to a different document draft", async () => {
  const finishUpload = pendingUpload();
  await using screen = await render(
    <LinearDocuments
      environmentId={environmentId}
      search={{ view: "documents", team: "team" }}
      change={vi.fn()}
      mutate={vi.fn()}
      canWrite
    />,
  );
  await screen.getByRole("button", { name: "New document" }).click();
  await userEvent.upload(
    screen.getByLabelText("Upload a file to Linear"),
    new File(["a"], "a.txt"),
  );
  await expect.poll(() => commands.upload.mock.calls.length).toBe(1);
  await screen.getByRole("button", { name: "New document" }).click();
  await screen.getByLabelText("Document title").fill("Second draft");
  await screen.getByLabelText("Document content").fill("Keep this content");
  await act(finishUpload);
  await expect.element(screen.getByLabelText("Document content")).toHaveValue("Keep this content");
  await expect.element(screen.getByRole("button", { name: "Save document" })).toBeEnabled();
});

it.each(["document", "issue"] as const)(
  "waits for the upload before saving a %s and includes its link",
  async (kind) => {
    const finishUpload = pendingUpload();
    const mutate = vi.fn().mockResolvedValue({ success: true, id: "saved" });
    const saveLabel = kind === "document" ? "Save document" : "Create issue";
    await using screen = await render(
      kind === "document" ? (
        <LinearDocuments
          environmentId={environmentId}
          search={{ view: "documents", team: "team" }}
          change={vi.fn()}
          mutate={mutate}
          canWrite
        />
      ) : (
        <LinearIssuePanel
          environmentId={environmentId}
          issueId={undefined}
          teamId="team"
          parentId={undefined}
          workspace={workspace}
          mutate={mutate}
          canWrite
          onClose={vi.fn()}
          onOpen={vi.fn()}
          onSubissue={vi.fn()}
          onViewSubissues={vi.fn()}
        />
      ),
    );
    if (kind === "document") await screen.getByRole("button", { name: "New document" }).click();
    await screen
      .getByLabelText(kind === "document" ? "Document title" : "Title", { exact: true })
      .fill("Draft");
    await userEvent.upload(
      screen.getByLabelText("Upload a file to Linear"),
      new File(["a"], "proof.txt"),
    );
    await expect.poll(() => commands.upload.mock.calls.length).toBe(1);
    await expect.element(screen.getByRole("button", { name: saveLabel })).toBeDisabled();
    await act(() => screen.container.querySelector("form")!.requestSubmit());
    expect(mutate).not.toHaveBeenCalled();
    await act(finishUpload);
    await expect.element(screen.getByRole("button", { name: saveLabel })).toBeEnabled();
    await screen.getByRole("button", { name: saveLabel }).click();
    expect(mutate).toHaveBeenCalledOnce();
    const fields = mutate.mock.calls[0]![0].input;
    expect(kind === "document" ? fields.content : fields.description).toContain(
      "[proof.txt](https://uploads.linear.app/proof.txt)",
    );
  },
);

it("starts work when an emoji straddles the prompt limit", async () => {
  await using screen = await render(
    <LinearIssuePanel
      environmentId={environmentId}
      issueId="issue"
      teamId="team"
      parentId={undefined}
      workspace={workspace}
      mutate={vi.fn()}
      canWrite
      onClose={vi.fn()}
      onOpen={vi.fn()}
      onSubissue={vi.fn()}
      onViewSubissues={vi.fn()}
    />,
  );
  await screen.getByRole("button", { name: "Start work" }).click();
  await expect.poll(() => screen.router!.state.location.pathname).toBe("/new");
  const prompt = new URLSearchParams(screen.router!.state.location.searchStr).get("prompt");
  expect(prompt).toContain("TEAM-1: Task");
  expect(prompt!.length).toBeLessThanOrEqual(8000);
});
