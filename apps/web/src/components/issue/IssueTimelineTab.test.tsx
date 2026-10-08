import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  type IssueDetailView,
  type IssueRef,
} from "@t3tools/contracts";
import { Fragment, act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  listeners: new Set<() => void>(),
  updateComment: vi.fn(),
}));

vi.mock("~/state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (_id: string, scope: string) =>
    scope === AuthSourceControlWriteScope && state.allowed;
  return {
    readEnvironmentScope,
    useEnvironmentScope: (id: string, scope: string) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.updateComment }));
vi.mock("~/state/issues", () => ({ issueEnvironment: { updateComment: "updateComment" } }));
vi.mock("~/lib/openIssueLink", () => ({ openLinkInBrowser: vi.fn() }));
vi.mock("~/lib/utils", () => ({ cn: () => "" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../pullRequest/PullRequestMarkdown", () => ({ PullRequestMarkdown: () => null }));
vi.mock("./IssueReactions", () => ({ IssueReactionBar: () => null }));
vi.mock("../sourceControl/TimelineRail", () => ({ ActorName: () => null, IconMarker: () => null }));
vi.mock("../sourceControl/ConversationGroup", () => ({
  ConversationGroup: ({
    entries,
    renderActions,
    renderBody,
  }: {
    entries: ReadonlyArray<{ id: string }>;
    renderActions: (entry: { id: string }) => ReactNode;
    renderBody: (entry: { id: string }) => ReactNode;
  }) =>
    entries.map((entry) => (
      <Fragment key={entry.id}>
        {renderActions(entry)}
        {renderBody(entry)}
      </Fragment>
    )),
}));

import { IssueTimelineTab } from "./IssueTimelineTab";

const environmentId = EnvironmentId.make("secondary");
const reference = { projectId: "project", repository: "acme/app", number: 1 } as IssueRef;
const actor = { login: "me", name: null, avatarUrl: null };
const writable = {
  url: "https://github.com/acme/app/issues/1",
  workspaceRoot: "/repo",
  viewer: "me",
  createdAt: "2026-08-17T00:00:00Z",
  author: actor,
  events: [],
  nextCommentsCursor: null,
  capabilities: { editComment: true, reactions: true },
  comments: [
    {
      id: "comment-1",
      author: actor,
      body: "Original",
      createdAt: "2026-08-17T01:00:00Z",
      url: null,
    },
  ],
} as unknown as IssueDetailView;
const readOnly = {
  ...writable,
  capabilities: { ...writable.capabilities, editComment: false, reactions: false },
} as IssueDetailView;
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  state.allowed = true;
  state.listeners.clear();
  state.updateComment.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function timeline(detail: IssueDetailView) {
  return (
    <IssueTimelineTab
      environmentId={environmentId}
      reference={reference}
      detail={detail}
      order="oldest"
      onRefresh={() => undefined}
      onLoadMoreComments={() => undefined}
      loadingMoreComments={false}
    />
  );
}

async function setAccess(allowed: boolean) {
  await act(() => {
    state.allowed = allowed;
    renderer!.update(timeline(allowed ? writable : readOnly));
    state.listeners.forEach((listener) => listener());
  });
}

const save = () => renderer!.root.findByProps({ children: "Save" }).props.onClick();

it("keeps a comment edit through revoked write access and saves it once restored", async () => {
  await act(() => {
    renderer = create(timeline(writable));
  });
  await act(() => renderer!.root.findByProps({ "aria-label": "Edit comment" }).props.onClick());
  await act(() =>
    renderer!.root.findByType("textarea").props.onChange({ target: { value: "Unsaved edit" } }),
  );

  await setAccess(false);
  expect(renderer!.root.findByType("textarea").props.value).toBe("Unsaved edit");
  await act(() => save());
  expect(state.updateComment).not.toHaveBeenCalled();

  await setAccess(true);
  await act(() => save());
  expect(state.updateComment).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { ...reference, commentId: "comment-1", body: "Unsaved edit" },
  });
});
