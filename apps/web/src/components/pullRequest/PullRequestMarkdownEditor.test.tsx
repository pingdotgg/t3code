import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("./PullRequestMarkdown", () => ({ PullRequestMarkdown: () => null }));
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { usePullRequestReviewStore } from "./pullRequestReviewStore";

let renderer: ReactTestRenderer | undefined;
const onCancel = vi.fn();
const onSave = vi.fn();
function editor(draftKey = "environment:review:comment-a", value = "Original") {
  return (
    <PullRequestMarkdownEditor
      draftKey={draftKey}
      value={value}
      cwd="/repo"
      environmentId={EnvironmentId.make("environment")}
      label="Edit comment"
      saving={false}
      onSave={onSave}
      onCancel={onCancel}
    />
  );
}
function edit(value: string) {
  act(() => renderer!.root.findByType("textarea").props.onChange({ target: { value } }));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  usePullRequestReviewStore.setState({ editorDrafts: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("PR edit draft lifetime", () => {
  it("retains edited text across Cancel and reopening the same target", () => {
    act(() => {
      renderer = create(editor());
    });
    edit("Invested input");
    act(() =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Cancel"))!
        .props.onClick(),
    );
    expect(onCancel).toHaveBeenCalledOnce();
    act(() => renderer!.unmount());
    act(() => {
      renderer = create(editor());
    });
    expect(renderer!.root.findByType("textarea").props.value).toBe("Invested input");
  });

  it("keeps each target's draft when a mounted editor changes subjects", () => {
    act(() => {
      renderer = create(editor());
    });
    edit("First target's edit");
    act(() => renderer!.update(editor("environment:review:comment-b", "Second target")));
    expect(renderer!.root.findByType("textarea").props.value).toBe("Second target");
    edit("Second target's edit");
    act(() => renderer!.update(editor()));
    expect(renderer!.root.findByType("textarea").props.value).toBe("First target's edit");
  });

  it("does not erase invested input when the remote body refreshes", () => {
    act(() => {
      renderer = create(editor());
    });
    edit("Local draft");
    act(() => renderer!.update(editor("environment:review:comment-a", "Remote update")));
    expect(renderer!.root.findByType("textarea").props.value).toBe("Local draft");
  });
});
