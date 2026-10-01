// @vitest-environment jsdom

import { Tooltip as SdkTooltip } from "@t3tools/extension-sdk/authoring";
import type { ClientHost, TooltipProps } from "@t3tools/extension-sdk/environment";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "~/components/ui/tooltip";

import { hostTooltip } from "./hostTooltip";

const { Tooltip } = hostTooltip;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type Props = Omit<TooltipProps, "children"> & { readonly disabled?: boolean };

function Control({ disabled = false, ...props }: Props) {
  return (
    <div style={{ display: "flex" }} data-testid="row">
      <Tooltip {...props}>
        <button type="button" aria-label="Back" disabled={disabled}>
          ←
        </button>
      </Tooltip>
    </div>
  );
}

async function render(node: React.ReactNode) {
  await act(async () => root.render(<TooltipProvider delay={0}>{node}</TooltipProvider>));
}

function button() {
  const element = container.querySelector("button");
  if (!element) throw new Error("Control was not rendered");
  return element;
}

/** The open popup's text, or null. The popup portals to the document body. */
function popupText(): string | null {
  return document.querySelector('[data-slot="tooltip-popup"]')?.textContent ?? null;
}

/** Flushes React work queued by the popup's open and close. */
async function settle() {
  await act(async () => {});
}

async function hover(target: Element) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseenter"));
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  await settle();
}

async function unhover(target: Element) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseleave"));
  });
  await settle();
}

describe("host tooltip", () => {
  it("opens on hover over an enabled control and closes when the pointer leaves", async () => {
    await render(<Control label="Back" />);
    expect(popupText()).toBeNull();
    await hover(button());
    expect(popupText()).toBe("Back");
    await unhover(button());
    expect(popupText()).toBeNull();
  });

  it("opens on keyboard focus and dismisses on Escape", async () => {
    await render(<Control label="Open in system browser" />);
    await act(async () => button().focus());
    await settle();
    expect(popupText()).toBe("Open in system browser");
    await act(async () => {
      button().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(popupText()).toBeNull();
  });

  it("follows state-dependent wording while open", async () => {
    await render(<Control label="Refresh" />);
    await hover(button());
    expect(popupText()).toBe("Refresh");
    await render(<Control label="Loading…" />);
    await settle();
    expect(popupText()).toBe("Loading…");
  });

  it("stays silent on a disabled control and leaves it a direct child of its row", async () => {
    await render(<Control label="Back" disabled />);
    expect(button().parentElement?.dataset.testid).toBe("row");
    await hover(button());
    await act(async () => button().focus());
    await settle();
    expect(popupText()).toBeNull();
  });

  it("explains a disabled control only when the label opts in", async () => {
    const reason = "Page didn't load — pick unavailable until the page renders";
    await render(<Control label={reason} disabled showWhenDisabled />);
    const wrapper = button().parentElement!;
    expect(wrapper.tagName).toBe("SPAN");
    await hover(wrapper);
    expect(popupText()).toBe(reason);
    await unhover(wrapper);
    expect(popupText()).toBeNull();
  });

  it("lets keyboard users focus the disabled reason and dismiss it", async () => {
    const reason = "Asking someone to review needs write access on this repository";
    await render(<Control label={reason} disabled showWhenDisabled />);
    const wrapper = button().parentElement!;
    await act(async () => wrapper.focus());
    await settle();
    expect(document.activeElement).toBe(wrapper);
    expect(popupText()).toBe(reason);
    await act(async () => {
      wrapper.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(popupText()).toBeNull();
    expect(button().disabled).toBe(true);
  });

  it("keeps an opted-in control's wrapper across enable and disable", async () => {
    await render(<Control label="Annotate elements, regions, and drawings" showWhenDisabled />);
    const wrapper = button().parentElement!;
    expect(button().disabled).toBe(false);
    await render(
      <Control label="Annotate elements, regions, and drawings" showWhenDisabled disabled />,
    );
    expect(button().disabled).toBe(true);
    expect(button().parentElement).toBe(wrapper);
    // Inline, with no flex-shrink override: the row lays the wrapper out as
    // it laid out the bare control.
    expect(wrapper.className.split(" ")).not.toContain("shrink-0");
    expect(wrapper.className.split(" ")).toContain("inline-flex");
  });

  it("renders the control alone when there is nothing to say", async () => {
    for (const label of ["", null, undefined]) {
      await render(<Control label={label} />);
      expect(button().parentElement?.dataset.testid).toBe("row");
      await hover(button());
      expect(popupText()).toBeNull();
    }
  });
});

describe("authoring Tooltip over the host primitive", () => {
  function Pack({ host }: { host: Pick<ClientHost, "React" | "tooltip"> }) {
    return (
      <div data-testid="row">
        <SdkTooltip host={host} label="More">
          <button type="button" aria-label="Preview menu">
            ⋯
          </button>
        </SdkTooltip>
      </div>
    );
  }

  it("shows the host tooltip where the host offers one", async () => {
    await render(<Pack host={{ React, tooltip: hostTooltip }} />);
    await hover(button());
    expect(popupText()).toBe("More");
  });

  it("keeps the trigger usable on hosts without a valid tooltip", async () => {
    const malformed = [
      undefined,
      { version: 0, Tooltip },
      { version: 1.5, Tooltip },
      { version: 1, Tooltip: { $$typeof: Symbol.for("react.memo") } },
      { version: 1, Tooltip: <span /> },
    ] as unknown as ClientHost["tooltip"][];
    for (const tooltip of malformed) {
      await render(<Pack host={{ React, ...(tooltip ? { tooltip } : {}) }} />);
      expect(button().parentElement?.dataset.testid).toBe("row");
      expect(button().getAttribute("aria-label")).toBe("Preview menu");
      await hover(button());
      expect(popupText()).toBeNull();
    }
  });
});
