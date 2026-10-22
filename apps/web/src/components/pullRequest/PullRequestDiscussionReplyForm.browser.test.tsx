import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, type PullRequestRef } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { type ComponentProps, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render as renderUi } from "../../../test/render";

const state = vi.hoisted(() => ({
  permission: null as Atom.Writable<boolean> | null,
  post: vi.fn<(...args: unknown[]) => Promise<{ _tag: "Success" | "Failure" }>>(),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.post) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      replyToThread: {
        ...actual.pullRequestEnvironment.replyToThread,
        permissionAtom: () => state.permission!,
      },
      setThreadResolution: {
        ...actual.pullRequestEnvironment.setThreadResolution,
        permissionAtom: () => state.permission!,
      },
    },
  };
});

import { PullRequestDiscussionReplyForm } from "./PullRequestDiscussionReplyForm";

const environmentId = EnvironmentId.make("environment");
const reference: PullRequestRef = {
  projectId: ProjectId.make("project"),
  host: "dev.azure.com",
  repository: "review-demo",
  number: 1336,
};
const onReplied = vi.fn();
const formNode = (props: Partial<ComponentProps<typeof PullRequestDiscussionReplyForm>> = {}) => (
  <PullRequestDiscussionReplyForm
    environmentId={environmentId}
    reference={reference}
    threadId="7734"
    onReplied={onReplied}
    {...props}
  />
);
const button = (name: string) => page.getByRole("button", { name, exact: true });
const input = () => page.getByRole("textbox", { name: "Reply to this discussion" });
const type = (body: string) => userEvent.fill(input(), body);
const open = () => button("Reply to this discussion").click();

function setup() {
  state.permission = Atom.make(true);
  const registry = AtomRegistry.make();
  state.post.mockReset().mockResolvedValue({ _tag: "Success" });
  onReplied.mockReset();
  return {
    registry,
    wrap: (node: ReactNode) => (
      <RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it("posts to the discussion once, keeps the draft locked in flight, and refreshes on success", async () => {
  using fixture = setup();
  await using _screen = await renderUi(fixture.wrap(formNode()));
  let complete!: (value: { _tag: "Success" }) => void;
  state.post.mockReturnValueOnce(new Promise((resolve) => (complete = resolve)));
  await open();
  await expect.element(button("Post reply")).toBeDisabled();
  await type("  Réponse avec **markdown**\nSecond line.  ");
  const post = button("Post reply").element() as HTMLButtonElement;
  await act(async () => {
    post.click();
    post.click();
  });
  expect(state.post).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { ...reference, threadId: "7734", body: "Réponse avec **markdown**\nSecond line." },
  });
  await expect.element(input()).toBeDisabled();
  expect(onReplied).not.toHaveBeenCalled();
  await act(async () => complete({ _tag: "Success" }));
  await expect.element(input()).not.toBeInTheDocument();
  expect(onReplied).toHaveBeenCalledOnce();
  await open();
  await expect.element(input()).toHaveValue("");
});

it("preserves a failed reply for retry and preserves a canceled draft", async () => {
  using fixture = setup();
  await using _screen = await renderUi(fixture.wrap(formNode()));
  state.post.mockResolvedValueOnce({ _tag: "Failure" });
  await open();
  await type("Keep this draft");
  await button("Post reply").click();
  await expect.element(input()).toHaveValue("Keep this draft");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not post the reply. Your draft is still here; try again.");
  expect(onReplied).not.toHaveBeenCalled();
  await button("Cancel").click();
  await open();
  await expect.element(input()).toHaveValue("Keep this draft");
  await button("Post reply").click();
  expect(onReplied).toHaveBeenCalledOnce();
});

it("refuses to post after write permission is removed", async () => {
  using fixture = setup();
  await using _screen = await renderUi(fixture.wrap(formNode()));
  await open();
  await type("Draft");
  await act(async () => fixture.registry.set(state.permission!, false));
  await expect.element(button("Post reply")).toBeDisabled();
  await act(async () => (button("Post reply").element() as HTMLButtonElement).click());
  expect(state.post).not.toHaveBeenCalled();
  await expect.element(input()).toHaveValue("Draft");
});

it("does not carry a reply draft into another PR with the same thread id", async () => {
  using fixture = setup();
  await using screen = await renderUi(fixture.wrap(formNode()));
  await open();
  await type("For the first PR");
  await screen.rerender(fixture.wrap(formNode({ reference: { ...reference, number: 1337 } })));
  await expect.element(input()).not.toBeInTheDocument();
  await open();
  await expect.element(input()).toHaveValue("");
});

it("clears a posted reply when resolution fails so retry cannot post it twice", async () => {
  using fixture = setup();
  await using _screen = await renderUi(fixture.wrap(formNode({ canResolve: true })));
  await open();
  await type("This is a test for the app t3code.");
  state.post.mockResolvedValueOnce({ _tag: "Success" }).mockResolvedValueOnce({ _tag: "Failure" });
  await button("Reply & resolve").click();
  expect(state.post).toHaveBeenCalledTimes(2);
  await expect.element(input()).toHaveValue("");
  await expect.element(button("Post reply")).toBeDisabled();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Your reply was posted, but the discussion could not be resolved. Use its status control to retry.",
    );
  expect(onReplied).toHaveBeenCalledOnce();
});

it("does not resolve a discussion that closed while the reply was posting", async () => {
  using fixture = setup();
  await using screen = await renderUi(fixture.wrap(formNode({ canResolve: true })));
  await open();
  await type("Closing this out.");
  let complete!: (value: { _tag: "Success" }) => void;
  state.post.mockReturnValueOnce(new Promise((resolve) => (complete = resolve)));
  await button("Reply & resolve").click();
  await screen.rerender(fixture.wrap(formNode({ canResolve: false })));
  await expect.element(button("Reply & resolve")).not.toBeInTheDocument();
  await act(async () => complete({ _tag: "Success" }));
  expect(state.post).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { ...reference, threadId: "7734", body: "Closing this out." },
  });
  expect(onReplied).toHaveBeenCalledOnce();
});
