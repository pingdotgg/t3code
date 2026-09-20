import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, type ReactNode, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  start: vi.fn(),
  awaitUploads: vi.fn(),
  read: vi.fn(),
  release: vi.fn(),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.upload }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { uploadAttachment: {} } }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: mocks.start,
  awaitAttachmentUploads: mocks.awaitUploads,
  readAttachmentUpload: mocks.read,
  releaseAttachmentUpload: mocks.release,
}));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Toggle: "button",
}));
vi.mock("./PullRequestMarkdown", () => ({
  PullRequestMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
}));

import { PullRequestAttachmentProvider } from "./PullRequestMarkdownField";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";

const environmentId = EnvironmentId.make("environment");
const reference = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 };
const capabilities = { supported: true, maxBytes: 1024, destination: "pull-request" as const };
let renderer: ReactTestRenderer;
const save = vi.fn();
const draft = vi.fn();
const textarea = { value: "", selectionStart: 0, setSelectionRange: vi.fn() };

function form(
  overrides: Partial<ComponentProps<typeof PullRequestAttachmentProvider>> = {},
  value = "Original",
  subject = "comment-1",
) {
  return (
    <PullRequestAttachmentProvider
      environmentId={environmentId}
      reference={reference}
      capabilities={capabilities}
      cwd="/repo"
      url="https://host/owner/repo/pull/1"
      {...overrides}
    >
      <PullRequestMarkdownEditor
        key={subject}
        value={value}
        cwd="/repo"
        environmentId={environmentId}
        label="Comment"
        saving={false}
        onSave={save}
        onDraftChange={draft}
        onCancel={() => {}}
      />
    </PullRequestAttachmentProvider>
  );
}

async function mount(overrides: Parameters<typeof form>[0] = {}) {
  await act(async () => {
    renderer = create(form(overrides), {
      createNodeMock: (element) => (element.type === "textarea" ? textarea : null),
    });
  });
}

async function attach(file = new File(["bytes"], "example.png", { type: "image/png" })) {
  await act(async () => {
    renderer.root
      .findByProps({ type: "file" })
      .props.onChange({ target: { files: [file], value: "" } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("document", { activeElement: textarea });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 1;
  });
  mocks.awaitUploads.mockResolvedValue(undefined);
  mocks.read.mockReturnValue({ status: "ready", attachmentId: "pending-1" });
  mocks.upload.mockResolvedValue({
    _tag: "Success",
    value: { markdown: "![example](https://host/native.png)", url: "https://host/native.png" },
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("keeps typing during native upload, inserts at the current caret, and blocks Save until ready", async () => {
  let finish!: (value: unknown) => void;
  mocks.upload.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await attach();
  expect(
    renderer.root.findAllByType("button").find((button) => button.props.children === "Save")?.props
      .disabled,
  ).toBe(true);
  await act(async () => {
    textarea.value = "Original extra";
    textarea.selectionStart = textarea.value.length;
    renderer.root.findByType("textarea").props.onChange({ target: { value: textarea.value } });
  });
  await act(async () => {
    finish({ _tag: "Success", value: { markdown: "![example](https://host/native.png)" } });
  });
  expect(renderer.root.findByType("textarea").props.value).toBe(
    "Original extra\n![example](https://host/native.png)\n",
  );
  expect(draft).toHaveBeenLastCalledWith("Original extra\n![example](https://host/native.png)\n");
  expect(save).not.toHaveBeenCalled();
  expect(mocks.upload).toHaveBeenCalledWith({
    environmentId,
    input: { ...reference, attachmentId: "pending-1", name: "example.png", mimeType: "image/png" },
  });
  expect(mocks.release).toHaveBeenCalled();
  expect(
    renderer.root.findAllByType("button").find((button) => button.props.children === "Save")?.props
      .disabled,
  ).toBe(false);
});

it("keeps failed files for retry and never inserts local attachment URLs", async () => {
  mocks.read.mockReturnValueOnce({ status: "failed", reason: "Connection lost" });
  await mount();
  await attach();
  expect(renderer.root.findByType("textarea").props.value).toBe("Original");
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(
    renderer.root.findAllByType("button").find((button) => button.props.children === "Save")?.props
      .disabled,
  ).toBe(true);
  textarea.selectionStart = 8;
  await act(async () => {
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Retry")
      ?.props.onClick();
  });
  expect(renderer.root.findByType("textarea").props.value).toBe(
    "Original\n![example](https://host/native.png)\n",
  );
});

it("validates host limits before upload and gives old servers a direct-host fallback", async () => {
  await mount({ capabilities: { ...capabilities, acceptedExtensions: [".png"] } });
  await attach(new File(["bytes"], "notes.txt"));
  expect(mocks.start).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ role: "alert" }).props.children).toContain("accepts .png");
  await attach(new File(["x".repeat(2048)], "large.png"));
  expect(mocks.start).not.toHaveBeenCalled();
  await act(async () => renderer.update(form({ capabilities: undefined })));
  await act(async () => {
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children?.includes?.("Attach files"))
      ?.props.onClick();
  });
  expect(renderer.root.findByProps({ role: "alert" }).props.children).toContain("Update T3 Code");
  expect(
    renderer.root
      .findAllByType("button")
      .some((button) => button.props.children === "Open on source host"),
  ).toBe(true);
});

it("does not put a completed upload into another pull request draft", async () => {
  let finish!: (value: unknown) => void;
  mocks.upload.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await attach();
  await act(async () => renderer.update(form({ reference: { ...reference, number: 2 } })));
  await act(async () => {
    finish({ _tag: "Success", value: { markdown: "![old](https://host/old.png)" } });
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("Original");
  expect(draft).not.toHaveBeenCalled();
});

it("accepts dropped and pasted files and removes a pending upload without changing the draft", async () => {
  let finish!: (value: unknown) => void;
  mocks.upload.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  const file = new File(["bytes"], "pasted.png", { type: "image/png" });
  const preventDefault = vi.fn();
  await act(async () => {
    renderer.root
      .findByType("textarea")
      .props.onPaste({ clipboardData: { files: [file] }, preventDefault, defaultPrevented: false });
  });
  expect(preventDefault).toHaveBeenCalled();
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Remove pasted.png" }).props.onClick();
  });
  await act(async () => {
    finish({ _tag: "Success", value: { markdown: "![pasted](https://host/pasted.png)" } });
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("Original");
  mocks.upload.mockResolvedValue({
    _tag: "Success",
    value: { markdown: "![dropped](https://host/dropped.png)" },
  });
  textarea.selectionStart = 8;
  await act(async () => {
    renderer.root
      .findAllByType("div")
      .find((element) => element.props.onDrop)
      ?.props.onDrop({ dataTransfer: { files: [file] }, preventDefault, stopPropagation: vi.fn() });
  });
  expect(renderer.root.findByType("textarea").props.value).toBe(
    "Original\n![dropped](https://host/dropped.png)\n",
  );
});

it("keeps a local draft and attachment when the host body refreshes, and resets for another subject", async () => {
  await mount();
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "My local draft" } }),
  );
  textarea.selectionStart = "My local draft".length;
  await attach();
  const local = renderer.root.findByType("textarea").props.value;
  expect(local).toContain("My local draft");
  expect(local).toContain("https://host/native.png");
  await act(async () => renderer.update(form({}, "Changed on another device")));
  expect(renderer.root.findByType("textarea").props.value).toBe(local);
  await act(async () => renderer.update(form({}, "Other comment", "comment-2")));
  expect(renderer.root.findByType("textarea").props.value).toBe("Other comment");
});
