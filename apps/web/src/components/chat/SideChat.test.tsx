import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SideChatSession } from "./SideChat";

const state = vi.hoisted(() => ({ start: vi.fn(), thread: {} as Record<string, unknown> }));
vi.mock("../../state/entities", () => ({ useThread: () => state.thread }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startTurn: "start" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.start }));
vi.mock("../../modelSelection", () => ({ getAppModelOptionsForInstance: () => [] }));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock("./ChatComposer", () => ({ ComposerFooterModeControls: () => null }));
vi.mock("./TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("./ComposerPrimaryActions", () => ({
  ComposerPrimaryActions: () => <button type="submit">Send</button>,
}));
vi.mock("./ProviderModelPicker", () => ({
  ProviderModelPicker: ({
    onInstanceModelChange,
  }: {
    onInstanceModelChange: (id: string, model: string) => void;
  }) => (
    <button onClick={() => onInstanceModelChange("codex", "side-model")}>Choose side model</button>
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: () => ({}),
  getUploadedAttachments: () => [],
  releaseAttachmentUpload: vi.fn(),
  startAttachmentUpload: vi.fn(),
  retryAttachmentUpload: vi.fn(),
}));

let renderer: ReactTestRenderer;
const source = {
  id: "main",
  environmentId: "env",
  modelSelection: { instanceId: "codex", model: "main-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
};
const props = {
  source,
  cwd: undefined,
  threadId: "side",
  prompt: "Explain jitter",
  active: true,
  settings: {},
  instanceEntries: [],
} as unknown as ComponentProps<typeof SideChatSession>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.start.mockReset().mockResolvedValue({ _tag: "Success" });
  state.thread = {
    ...source,
    id: "side",
    messages: [
      { id: "answer", role: "assistant", text: "Keep the same idempotency key.", streaming: false },
    ],
    activities: [],
    session: null,
  };
  await act(async () => {
    renderer = create(<SideChatSession {...props} />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("sends a completed finding to the parent with its model while preserving the side draft", async () => {
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Choose side model"))!
      .props.onClick(),
  );
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Send to Main Chat")!
      .props.onClick(),
  );
  expect(state.start.mock.calls[0]![0]).toMatchObject({
    environmentId: "env",
    input: {
      threadId: "main",
      modelSelection: source.modelSelection,
      message: {
        text: "Continue with this input from my side chat:\n\nKeep the same idempotency key.",
      },
    },
  });
  expect(renderer.root.findByType("textarea").props.value).toBe("Explain jitter");
  expect(
    renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Sent to Main Chat")!.props.disabled,
  ).toBe(true);
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(state.start.mock.calls[1]![0]).toMatchObject({
    input: {
      threadId: "side",
      modelSelection: { instanceId: "codex", model: "side-model" },
      message: { text: "Explain jitter" },
    },
  });
});

it("keeps send-back retryable after rejection without clearing a draft", async () => {
  state.start.mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Send to Main Chat")!
      .props.onClick(),
  );
  expect(renderer.root.findByType("textarea").props.value).toBe("Explain jitter");
  expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("Disconnected");
  expect(
    renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Send to Main Chat")!.props.disabled,
  ).toBe(false);
});
