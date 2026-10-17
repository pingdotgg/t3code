import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { ComposerHandleContext } from "~/composerHandleContext";
import type { ChatComposerHandle } from "./ChatComposer";
import { SendLaterControl } from "./SendLaterControl";

let root: Root;
let container: HTMLDivElement;
const onSendLater = vi.fn();
const onComposerSubmit = vi.fn();
const focusAtEnd = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSendLater.mockClear();
  onComposerSubmit.mockClear();
  focusAtEnd.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(canSend = true) {
  const composerRef = { current: { focusAtEnd } as unknown as ChatComposerHandle };
  await act(async () =>
    root.render(
      <ComposerHandleContext value={composerRef}>
        {/* The composer form: the popover's form must never submit it. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onComposerSubmit();
          }}
        >
          <SendLaterControl canSend={canSend} onSendLater={onSendLater} />
        </form>
      </ComposerHandleContext>,
    ),
  );
}

const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Send later"]')!;
const popover = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (name: string) =>
  [...(popover()?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent?.trim() === name,
  )!;
const minutesInput = () => popover()!.querySelector<HTMLInputElement>("input")!;

async function openCustom() {
  await userEvent.click(trigger());
  await userEvent.click(button("Custom…"));
}

async function expectClosed() {
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await vi.waitFor(() => expect(popover()).toBeNull());
}

describe("SendLaterControl", () => {
  it("schedules a preset immediately and returns focus to the composer", async () => {
    await render();
    await userEvent.click(trigger());

    await userEvent.click(button("In 2 minutes"));

    expect(onSendLater).toHaveBeenCalledExactlyOnceWith(2 * 60_000);
    expect(onComposerSubmit).not.toHaveBeenCalled();
    await expectClosed();
    expect(focusAtEnd).toHaveBeenCalled();
  });

  it("opens Custom inline at 10 minutes, focused, without scheduling", async () => {
    await render();
    await userEvent.click(trigger());
    expect(popover()!.querySelector("input")).toBeNull();

    await userEvent.click(button("Custom…"));

    expect(onSendLater).not.toHaveBeenCalled();
    expect(minutesInput().value).toBe("10");
    expect(document.activeElement).toBe(minutesInput());
  });

  it("schedules only a whole-minute delay in range and never submits the composer", async () => {
    await render();
    await openCustom();

    for (const invalid of ["0", "61", "1.5"]) {
      await userEvent.fill(minutesInput(), invalid);
      await userEvent.keyboard("{Enter}");
      expect(minutesInput().getAttribute("aria-invalid")).toBe("true");
    }
    expect(popover()!.textContent).toContain("Enter a whole number from 1–60.");
    expect(onSendLater).not.toHaveBeenCalled();

    await userEvent.fill(minutesInput(), "60");
    await userEvent.keyboard("{Enter}");

    expect(onSendLater).toHaveBeenCalledExactlyOnceWith(60 * 60_000);
    expect(onComposerSubmit).not.toHaveBeenCalled();
    await expectClosed();
  });

  it("schedules a custom delay from the Schedule button", async () => {
    await render();
    await openCustom();

    await userEvent.fill(minutesInput(), "7");
    await userEvent.click(button("Schedule"));

    expect(onSendLater).toHaveBeenCalledExactlyOnceWith(7 * 60_000);
    expect(onComposerSubmit).not.toHaveBeenCalled();
    await expectClosed();
  });

  it("closes on Escape without sending", async () => {
    await render();
    await openCustom();

    await userEvent.keyboard("{Escape}");

    await expectClosed();
    expect(onSendLater).not.toHaveBeenCalled();
    expect(onComposerSubmit).not.toHaveBeenCalled();
  });

  it("stops scheduling while open once sending becomes unavailable", async () => {
    await render();
    await openCustom();

    await render(false);

    expect(button("In 1 minute").disabled).toBe(true);
    expect(button("Schedule").disabled).toBe(true);
    expect(popover()!.querySelector('[role="status"]')?.textContent).toContain(
      "Your message stays in the composer.",
    );
    // The field keeps Enter, but the held send must not go out.
    await userEvent.click(minutesInput());
    await userEvent.keyboard("{Enter}");
    expect(onSendLater).not.toHaveBeenCalled();
    expect(onComposerSubmit).not.toHaveBeenCalled();
  });
});
