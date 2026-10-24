import { act, render } from "../../../test/render";
import * as Cause from "effect/Cause";
import { RuntimeRequestId, type OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import type { PendingApproval } from "../../session-logic";
import { page, userEvent } from "vite-plus/test/browser";
import { type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { SideChatSession } from "./SideChat";

const state = vi.hoisted(() => ({
  start: vi.fn(),
  interrupt: vi.fn(),
  answer: vi.fn(),
  approve: vi.fn(),
  approvals: [] as PendingApproval[],
  userInputs: [] as ThreadPendingUserInput[],
  status: "running",
  visibleTurnItems: [] as OrchestrationV2ProjectedTurnItem[],
  ctrlKey: false,
  metaKey: false,
  selection: {
    instanceId: "codex",
    model: "parent-model",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({}),
  resolveThreadDetailRef: (ref: unknown) => ref,
  useThreadProjection: () => ({
    projection: {
      thread: {
        id: "side",
        modelSelection: state.selection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      messages: [{ id: "answer", role: "assistant", text: "Side answer", streaming: false }],
      turnItems: [],
      visibleTurnItems: state.visibleTurnItems,
    },
  }),
}));
vi.mock("@t3tools/client-runtime/state/thread-execution", () => ({
  deriveThreadRuntime: () => ({ status: state.status }),
}));
vi.mock(import("@t3tools/client-runtime/state/thread-requests"), async (importOriginal) => ({
  ...(await importOriginal()),
  derivePendingThreadRequests: () => ({ approvals: state.approvals, userInputs: state.userInputs }),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    startTurn: "start",
    interruptTurn: "interrupt",
    respondToUserInput: "answer",
    respondToApproval: "approve",
  },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (name: "start" | "interrupt" | "answer" | "approve") => state[name],
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: () => ({}),
  getUploadedAttachments: () => [],
  startAttachmentUpload: vi.fn(),
  releaseAttachmentUpload: vi.fn(),
  retryAttachmentUpload: vi.fn(),
}));
vi.mock("./ProviderModelPicker", () => ({
  ProviderModelPicker: ({ model }: { model: string }) => <button type="button">{model}</button>,
}));
vi.mock("./TraitsPicker", () => ({
  readPromptUltrathink: () => false,
  TraitsPicker: () => null,
  TraitsMenuContent: () => null,
  getReasoningTraitStep: () => null,
  shouldRenderTraitsControls: () => false,
  buildUnavailableModelOptionDescriptors: () => [],
  buildTraitsTriggerDisplay: () => null,
}));
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("./ComposerFooterControls", () => ({
  ComposerFooterModeControls: () => null,
}));
vi.mock("../../shortcutModifierState", () => ({
  useShortcutModifierState: () => state,
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

vi.mock("./SecretRequestCard", () => ({
  SecretRequestCard: ({
    environmentId,
    visibility,
    item,
  }: {
    environmentId: string;
    visibility: string;
    item: { id: string; threadId: string; label: string };
  }) => (
    <div
      data-secret-request={item.id}
      data-environment={environmentId}
      data-visibility={visibility}
      data-thread={item.threadId}
    >
      {item.label}
    </div>
  ),
}));

const props = () =>
  ({
    source: {
      environmentId: "env",
      id: "parent",
      modelSelection: state.selection,
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    threadId: "side",
    prompt: "Change direction",
    active: true,
    settings: { planModeEnabled: false },
    instanceEntries: [],
  }) as unknown as ComponentProps<typeof SideChatSession>;
const draft = () => document.querySelector("textarea")!;
const send = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
function setup() {
  state.status = "running";
  state.userInputs = [];
  state.approvals = [];
  state.approve.mockReset().mockResolvedValue({ _tag: "Success" });
  state.answer.mockReset().mockResolvedValue({ _tag: "Success" });
  state.visibleTurnItems = [];
  state.ctrlKey = false;
  state.metaKey = false;
  state.start.mockReset().mockResolvedValue({ _tag: "Success" });
  state.interrupt.mockReset().mockResolvedValue({ _tag: "Success" });
}
it("steers the side thread with the inherited model and clears only accepted input", async () => {
  setup();
  await using screen = await render(<SideChatSession {...props()} />);
  expect(send().getAttribute("aria-label")).toBe("Steer message");
  await act(async () => send().click());
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: "env",
      input: expect.objectContaining({
        threadId: "side",
        dispatchMode: "steer",
        modelSelection: state.selection,
        message: expect.objectContaining({ text: "Change direction" }),
      }),
    }),
  );
  expect(draft().value).toBe("");
  expect(state.interrupt).not.toHaveBeenCalled();
});
it("keeps the failed steer draft for retry", async () => {
  setup();
  await using screen = await render(<SideChatSession {...props()} />);
  const container = screen.container;
  state.start.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("Steering unavailable")),
  });
  await act(async () => send().click());
  expect(draft().value).toBe("Change direction");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Steering unavailable");
  await act(async () => send().click());
  expect(draft().value).toBe("");
});
it("Enter steers and Shift+Enter keeps the multiline draft", async () => {
  setup();
  await using screen = await render(<SideChatSession {...props()} />);
  await act(async () =>
    draft().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    ),
  );
  expect(state.start).not.toHaveBeenCalled();
  await act(async () =>
    draft().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(state.start.mock.calls[0]![0].input.dispatchMode).toBe("steer");
});
it.each(["ctrlKey", "metaKey"] as const)(
  "keeps %s-click steering with no queue action",
  async (modifier) => {
    setup();
    await using screen = await render(<SideChatSession {...props()} />);
    const container = screen.container;
    state[modifier] = true;
    await screen.rerender(<SideChatSession {...props()} />);
    expect(send().getAttribute("aria-label")).toBe("Steer message");
    expect(container.textContent).not.toContain("Queue");
    await act(async () =>
      send().dispatchEvent(new MouseEvent("click", { bubbles: true, [modifier]: true })),
    );
    expect(state.start.mock.calls[0]![0].input.dispatchMode).toBe("steer");
  },
);
it("submits normally when idle, retaining the server-resolved steering intent for races", async () => {
  setup();
  await using screen = await render(<SideChatSession {...props()} />);
  state.status = "idle";
  await screen.rerender(<SideChatSession {...props()} />);
  expect(send().getAttribute("aria-label")).toBe("Submit message");
  await act(async () => send().click());
  expect(state.start.mock.calls[0]![0].input.dispatchMode).toBe("steer");
});

it("shows the side answer without a separate send-to-main action", async () => {
  setup();
  await using screen = await render(<SideChatSession {...props()} />);
  const container = screen.container;
  await screen.rerender(<SideChatSession {...props()} />);
  expect(container.textContent).toContain("Side answer");
  expect(container.querySelector('[aria-label="Send to Main Chat"]')).toBeNull();
  expect(state.start).not.toHaveBeenCalled();
});

it.each(["local", "inherited"] as const)(
  "renders secret requests with their owning environment and %s visibility",
  async (visibility) => {
    setup();
    await using screen = await render(<SideChatSession {...props()} />);
    const container = screen.container;
    const threadId = visibility === "local" ? "side" : "parent";
    state.visibleTurnItems = [
      {
        position: 0,
        visibility,
        sourceThreadId: threadId,
        sourceItemId: "secret-card",
        item: {
          id: "secret-card",
          threadId,
          type: "secret_request",
          label: "Deploy token",
          secretStatus: "pending",
        },
      },
    ] as unknown as OrchestrationV2ProjectedTurnItem[];
    await screen.rerender(<SideChatSession {...props()} />);
    const card = container.querySelector('[data-secret-request="secret-card"]');
    expect(card?.textContent).toBe("Deploy token");
    expect(card?.getAttribute("data-environment")).toBe("env");
    expect(card?.getAttribute("data-visibility")).toBe(visibility);
    expect(card?.getAttribute("data-thread")).toBe(threadId);
  },
);

const editorRequest = (): ThreadPendingUserInput[] => [
  {
    requestId: RuntimeRequestId.make("edit-request"),
    createdAt: "2026-10-22T00:00:00Z",
    responseCapability: "live",
    dismissible: false,
    questions: [
      {
        id: "proposal",
        header: "Proposed text",
        multiSelect: false,
        question: "Review this text",
        options: [],
        initialAnswer: "  First line\nSecond line\n",
      },
    ],
  },
];
it("shows and submits a proposed editor answer without changing its whitespace", async () => {
  setup();
  await using screen = await render(<SideChatSession {...props()} />);
  const container = screen.container;
  state.userInputs = editorRequest();
  await screen.rerender(<SideChatSession {...props()} />);
  const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Proposed text"]')!;
  expect(field.value).toBe("  First line\nSecond line\n");
  await userEvent.click(page.getByRole("button", { name: "Reply", exact: true }));
  expect(state.answer).toHaveBeenCalledWith(
    expect.objectContaining({
      input: {
        threadId: "side",
        requestId: "edit-request",
        answers: { proposal: "  First line\nSecond line\n" },
      },
    }),
  );
});
it("preserves edits and an intentionally empty editor answer across projection refreshes", async () => {
  setup();
  await using screen = await render(<SideChatSession {...props()} />);
  const container = screen.container;
  state.userInputs = editorRequest();
  await screen.rerender(<SideChatSession {...props()} />);
  await userEvent.fill(
    page.getByRole("textbox", { name: "Proposed text", exact: true }),
    "Edited\ntext",
  );
  state.userInputs = editorRequest();
  await screen.rerender(<SideChatSession {...props()} />);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Proposed text"]')!.value).toBe(
    "Edited\ntext",
  );
  await userEvent.fill(page.getByRole("textbox", { name: "Proposed text", exact: true }), "");
  await screen.rerender(<SideChatSession {...props()} />);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Proposed text"]')!.value).toBe(
    "",
  );
  await userEvent.click(page.getByRole("button", { name: "Reply", exact: true }));
  expect(state.answer).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ answers: { proposal: "" } }) }),
  );
});

it("keeps stale approvals and non-resumable questions visible but prevents responses", async () => {
  setup();
  await using screen = await render(<SideChatSession {...props()} />);
  state.approvals = [
    {
      requestId: RuntimeRequestId.make("stale-approval"),
      createdAt: "2026-10-18T12:00:00.000Z",
      requestKind: "command",
      detail: "Run command?",
      responseCapability: "not_resumable",
      options: [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptForSession", label: "Always allow" },
      ],
    },
  ];
  state.userInputs = editorRequest().map((request) => ({
    ...request,
    responseCapability: "not_resumable",
  }));
  await screen.rerender(<SideChatSession {...props()} />);
  await expect
    .element(page.getByRole("button", { name: "Allow once", exact: true }))
    .toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Reply", exact: true })).toBeDisabled();
  expect(state.approve).not.toHaveBeenCalled();
  expect(state.answer).not.toHaveBeenCalled();
  state.approvals = state.approvals.map((approval) => ({
    ...approval,
    responseCapability: "live",
  }));
  state.userInputs = [];
  await screen.rerender(<SideChatSession {...props()} />);
  await userEvent.click(page.getByRole("button", { name: "Allow once", exact: true }));
  expect(state.approve).toHaveBeenCalledWith(
    expect.objectContaining({
      input: { threadId: "side", requestId: "stale-approval", decision: "accept" },
    }),
  );
});
