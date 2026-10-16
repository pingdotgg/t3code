import { EnvironmentId, ProjectId, type PullRequestRef } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  post: vi.fn<(...args: unknown[]) => Promise<{ _tag: "Success" | "Failure" }>>(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.post }));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    replyToThread: { permissionAtom: () => null },
    setThreadResolution: { permissionAtom: () => null },
  },
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));

import { PullRequestDiscussionReplyForm } from "./PullRequestDiscussionReplyForm";

const environmentId = EnvironmentId.make("environment");
const reference: PullRequestRef = {
  projectId: ProjectId.make("project"),
  host: "dev.azure.com",
  repository: "review-demo",
  number: 1336,
};
const onReplied = vi.fn();
let renderer: ReactTestRenderer;
const render = (ref = reference) => (
  <PullRequestDiscussionReplyForm
    environmentId={environmentId}
    reference={ref}
    threadId="7734"
    onReplied={onReplied}
  />
);
const button = (label: string) => renderer.root.findByProps({ "aria-label": label });
const type = (body: string) =>
  act(() => renderer.root.findByType("textarea").props.onChange({ target: { value: body } }));
const open = () => act(() => button("Reply to this discussion").props.onClick());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.post.mockReset().mockResolvedValue({ _tag: "Success" });
  onReplied.mockReset();
  act(() => {
    renderer = create(render());
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("posts to the discussion once, keeps the draft locked in flight, and refreshes on success", async () => {
  let complete!: (value: { _tag: "Success" }) => void;
  state.post.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  open();
  expect(button("Post reply").props.disabled).toBe(true);
  type("  Réponse avec **markdown**\nSecond line.  ");
  await act(async () => {
    void button("Post reply").props.onClick();
    void button("Post reply").props.onClick();
  });
  expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.post).toHaveBeenCalledWith({
    environmentId,
    input: { ...reference, threadId: "7734", body: "Réponse avec **markdown**\nSecond line." },
  });
  expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
  expect(onReplied).not.toHaveBeenCalled();
  await act(async () => complete({ _tag: "Success" }));
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  expect(onReplied).toHaveBeenCalledOnce();
  open();
  expect(renderer.root.findByType("textarea").props.value).toBe("");
});

it("preserves a failed reply for retry and preserves a canceled draft", async () => {
  state.post.mockResolvedValueOnce({ _tag: "Failure" });
  open();
  type("Keep this draft");
  await act(async () => button("Post reply").props.onClick());
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep this draft");
  expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "Could not post",
  );
  expect(onReplied).not.toHaveBeenCalled();
  act(() =>
    renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Cancel"))!
      .props.onClick(),
  );
  open();
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep this draft");
  await act(async () => button("Post reply").props.onClick());
  expect(onReplied).toHaveBeenCalledOnce();
});

it("refuses to post after write permission is removed", async () => {
  open();
  type("Draft");
  state.allowed = false;
  act(() => renderer.update(render()));
  expect(button("Post reply").props.disabled).toBe(true);
  await act(async () => button("Post reply").props.onClick());
  expect(state.post).not.toHaveBeenCalled();
  expect(renderer.root.findByType("textarea").props.value).toBe("Draft");
});

it("does not carry a reply draft into another PR with the same thread id", () => {
  open();
  type("For the first PR");
  act(() => renderer.update(render({ ...reference, number: 1337 })));
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  open();
  expect(renderer.root.findByType("textarea").props.value).toBe("");
});

it("clears a posted reply when resolution fails so retry cannot post it twice", async () => {
  act(() =>
    renderer.update(
      <PullRequestDiscussionReplyForm
        environmentId={environmentId}
        reference={reference}
        threadId="7734"
        canResolve
        onReplied={onReplied}
      />,
    ),
  );
  open();
  type("This is a test for the app t3code.");
  state.post.mockResolvedValueOnce({ _tag: "Success" }).mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Reply & resolve")!
      .props.onClick(),
  );
  expect(state.post).toHaveBeenCalledTimes(2);
  expect(renderer.root.findByType("textarea").props.value).toBe("");
  expect(button("Post reply").props.disabled).toBe(true);
  expect(renderer.root.findByProps({ role: "alert" }).props.children).toContain(
    "Your reply was posted",
  );
  expect(onReplied).toHaveBeenCalledOnce();
});

it("does not resolve a discussion that closed while the reply was posting", async () => {
  const renderResolvable = (canResolve: boolean) => (
    <PullRequestDiscussionReplyForm
      environmentId={environmentId}
      reference={reference}
      threadId="7734"
      canResolve={canResolve}
      onReplied={onReplied}
    />
  );
  const replyAndResolve = () =>
    renderer.root.findAllByType("button").find((node) => node.props.children === "Reply & resolve");
  act(() => renderer.update(renderResolvable(true)));
  open();
  type("Closing this out.");
  let complete!: (value: { _tag: "Success" }) => void;
  state.post.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await act(async () => replyAndResolve()!.props.onClick());
  act(() => renderer.update(renderResolvable(false)));
  expect(replyAndResolve()).toBeUndefined();
  await act(async () => complete({ _tag: "Success" }));
  expect(state.post).toHaveBeenCalledOnce();
  expect(state.post).toHaveBeenCalledWith({
    environmentId,
    input: { ...reference, threadId: "7734", body: "Closing this out." },
  });
  expect(onReplied).toHaveBeenCalledOnce();
});
