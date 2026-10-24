import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { useState, type MouseEventHandler, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import "~/index.css";
import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ observeSource: vi.fn(), dispose: vi.fn(), navigate: vi.fn() }));
vi.mock(import("./AssistantCitationSource"), async (importOriginal) => ({
  ...(await importOriginal()),
  observeAssistantCitationCommentSource: mocks.observeSource,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => mocks.navigate,
  Link: (({ children, onClick }: { children: ReactNode; onClick?: MouseEventHandler }) => (
    <a href="#source" onClick={onClick}>
      {children}
    </a>
  )) as never,
}));

import { AssistantCitationChip } from "./AssistantCitationChip";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};

// The mocked source observer is shared, so every test starts by resetting it.
function setup() {
  mocks.observeSource.mockReset().mockReturnValue(mocks.dispose);
  mocks.dispose.mockClear();
  mocks.navigate.mockClear();
  const source = document.createElement("p");
  source.textContent = "hello";
  document.body.append(source);
  const range = document.createRange();
  range.selectNodeContents(source);
  const sourceAnchor = { source, range, viewport: document.body } as AssistantCitationSourceAnchor;
  return { sourceAnchor, [Symbol.dispose]: () => source.remove() };
}

function mount(
  sourceAnchor: AssistantCitationSourceAnchor,
  onSave: () => boolean,
  onCancel?: () => void,
) {
  function Composer() {
    const [open, setOpen] = useState(true);
    return (
      <AssistantCitationChip
        citation={citation}
        commentEditor={{
          open,
          sourceAnchor,
          onOpenChange: setOpen,
          onSave,
          ...(onCancel ? { onCancel } : {}),
        }}
      />
    );
  }
  return render(<Composer />);
}

const textarea = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on selected text"]');

async function typeComment(value: string) {
  const input = textarea()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function removeSource() {
  const { onUnavailable } = mocks.observeSource.mock.lastCall![0];
  await act(async () => onUnavailable());
}

// Once the source is gone the popup moves to the chip, which saves with Enter.
async function pressEnter() {
  textarea()!.focus();
  await userEvent.keyboard("{Enter}");
}

describe("citation comment source disappearance", () => {
  it("preserves an over-length draft at the composer until it can be shortened and saved", async () => {
    using source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave);
    const draft = "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1);
    await typeComment(draft);
    await removeSource();

    expect(textarea()?.value).toBe(draft);
    expect(textarea()?.getAttribute("aria-invalid")).toBe("true");
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.observeSource).toHaveBeenCalledTimes(1);

    await typeComment("shortened comment");
    await pressEnter();
    expect(onSave).toHaveBeenCalledWith("shortened comment");
    expect(textarea()).toBeNull();
  });

  it("preserves a rejected save and allows a later retry", async () => {
    using source = setup();
    const onSave = vi.fn(() => false);
    await using _screen = await mount(source.sourceAnchor, onSave);
    await typeComment("keep this draft");
    await removeSource();

    expect(onSave).toHaveBeenCalledWith("keep this draft");
    expect(textarea()?.value).toBe("keep this draft");
    onSave.mockReturnValue(true);
    await pressEnter();
    expect(onSave).toHaveBeenLastCalledWith("keep this draft");
    expect(textarea()).toBeNull();
  });

  it("removes a just-inserted quote on Escape from Go to source", async () => {
    using source = setup();
    const onCancel = vi.fn();
    await using _screen = await mount(
      source.sourceAnchor,
      vi.fn(() => true),
      onCancel,
    );
    await typeComment("x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1));
    await removeSource();

    page.getByRole("link", { name: "Go to source" }).element().focus();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("citation comment popup position", () => {
  it("stays on screen when the cited text ends in a code block's hidden overflow", async () => {
    using _source = setup();
    const message = document.createElement("div");
    message.className = "chat-markdown";
    message.style.width = "240px";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    // Highlighted code is split into token spans, so the range's last client rect
    // covers only the final token, wholly inside the hidden overflow.
    for (let index = 0; index < 40; index += 1) {
      const token = document.createElement("span");
      token.textContent = `token${index} `;
      code.append(token);
    }
    pre.append(code);
    message.append(pre);
    document.body.prepend(message);
    using _message = { [Symbol.dispose]: () => message.remove() };
    const range = document.createRange();
    range.selectNodeContents(code);
    const rects = range.getClientRects();
    expect(rects.item(rects.length - 1)!.left).toBeGreaterThan(window.innerWidth);
    const sourceAnchor = {
      source: message,
      range,
      viewport: document.body,
    } as AssistantCitationSourceAnchor;

    await using _screen = await mount(
      sourceAnchor,
      vi.fn(() => true),
    );
    const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
    await vi.waitFor(() => expect(popup()?.getBoundingClientRect().width).toBeGreaterThan(0));
    // Typing scrolls ancestors to reveal the caret, which shifts the whole app
    // sideways when the box is off screen.
    await userEvent.keyboard("note");

    expect(textarea()?.value).toBe("note");
    expect(document.scrollingElement?.scrollLeft).toBe(0);
    expect(document.body.scrollLeft).toBe(0);
    const rect = popup()!.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  });
});

describe("draft citation chip", () => {
  it("opens the quote with an editable comment, ready to type at its end", async () => {
    using _source = setup();
    const onSave = vi.fn(() => true);
    function Composer() {
      const [open, setOpen] = useState(false);
      return (
        <AssistantCitationChip
          citation={{ ...citation, comment: "note" }}
          commentEditor={{ open, onOpenChange: setOpen, onSave }}
        />
      );
    }
    await using _screen = await render(<Composer />);

    await page.getByRole("button", { name: /^Edit citation comment:/ }).click();

    await expect.element(page.getByRole("blockquote")).toHaveTextContent("hello");
    await expect.element(page.getByText("Go to source")).toBeVisible();
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea()));
    expect(textarea()?.selectionStart).toBe("note".length);
    expect(page.getByRole("button", { name: "Save" }).query()).toBeNull();

    await userEvent.keyboard(" again{Enter}");
    expect(onSave).toHaveBeenCalledWith("note again");
    expect(textarea()).toBeNull();
  });

  it("keeps the comment field and its caret in view under a long quote and comment", async () => {
    using _source = setup();
    function Composer() {
      const [open, setOpen] = useState(false);
      return (
        <AssistantCitationChip
          citation={{
            ...citation,
            text: "long line\n".repeat(80),
            comment: "long comment\n".repeat(40),
          }}
          commentEditor={{ open, onOpenChange: setOpen, onSave: () => true }}
        />
      );
    }
    await using _screen = await render(<Composer />);

    await page.getByRole("button", { name: /^Edit citation comment:/ }).click();

    await vi.waitFor(() => expect(document.activeElement).toBe(textarea()));
    await expect.element(page.getByLabelText("Comment on selected text")).toBeInViewport();
    const input = textarea()!;
    expect(input.scrollTop + input.clientHeight).toBeGreaterThanOrEqual(input.scrollHeight - 1);
  });

  it("stays on the page while the draft is too long to save", async () => {
    using _source = setup();
    function Composer() {
      const [open, setOpen] = useState(false);
      return (
        <AssistantCitationChip
          citation={citation}
          commentEditor={{ open, onOpenChange: setOpen, onSave: () => true }}
        />
      );
    }
    await using _screen = await render(<Composer />);
    await page.getByRole("button", { name: /^Add comment to citation:/ }).click();
    await vi.waitFor(() => expect(textarea()).not.toBeNull());

    await typeComment("x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1));
    await page.getByRole("link", { name: "Go to source" }).click();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(textarea()).not.toBeNull();

    await typeComment("short");
    await page.getByRole("link", { name: "Go to source" }).click();
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

  it("stays on the page when saving the draft fails", async () => {
    using _source = setup();
    const onSave = vi.fn(() => false);
    function Composer() {
      const [open, setOpen] = useState(false);
      return (
        <AssistantCitationChip
          citation={citation}
          commentEditor={{ open, onOpenChange: setOpen, onSave }}
        />
      );
    }
    await using _screen = await render(<Composer />);
    await page.getByRole("button", { name: /^Add comment to citation:/ }).click();
    await vi.waitFor(() => expect(textarea()).not.toBeNull());

    await typeComment("changed");
    await page.getByRole("link", { name: "Go to source" }).click();
    expect(onSave).toHaveBeenCalledWith("changed");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(textarea()?.value).toBe("changed");
  });
});
