// @vitest-environment jsdom

import type {
  BrowserCaptureTarget,
  PrsListEntry,
  PrsWriteActionKind,
  PrsWriteMergeMethod,
} from "@t3tools/extension-sdk/catalogue";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
// Checks whether a sibling pack's source is present in this checkout, outside Effect services.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as React from "react";
import { act, type ComponentType, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "~/components/ui/tooltip";

import { hostTooltip } from "./hostTooltip";

// First-party pack controls rendered through the real host tooltip. Packs
// are their own TypeScript projects, so they load by path, not by import.
const PACKS = new URL("../../../../packages/first-party-extensions", import.meta.url).pathname;
// The Browser pack ships in its own stack layer; its cases run where it is present.
// (jsdom's URL maps PACKS to a dev-server path, so check the real file system path.)
const HAS_BROWSER = NodeFS.existsSync(
  `${import.meta.dirname}/../../../../packages/first-party-extensions/browser/annotateButton.tsx`,
);

let PrsActionButton: ComponentType<{
  host: ClientHost;
  offer: {
    action: PrsWriteActionKind;
    label: string;
    destructive: boolean;
    methods?: readonly PrsWriteMergeMethod[];
  };
  disabled: boolean;
  pendingAction: string | null;
  method: string;
  onMethodChange: (value: string) => void;
  onRun: () => void;
}>;
let PrListRow: ComponentType<{
  host: ClientHost;
  entry: PrsListEntry;
  viewers: Readonly<Record<string, string>>;
  onSelect: () => void;
}>;
let AnnotateButton: ComponentType<{
  host: ClientHost;
  blockReason: string | null;
  capturing: BrowserCaptureTarget | null;
  pageFailed: boolean;
  onPick: () => void;
  style: CSSProperties;
}>;

let ScreenshotButton: ComponentType<{
  host: ClientHost;
  blockReason: string | null;
  capturing: BrowserCaptureTarget | null;
  pageFailed: boolean;
  onCapture: () => void;
  style: CSSProperties;
}>;

beforeAll(async () => {
  ({ PrsActionButton, PrListRow } = await import(
    /* @vite-ignore */ `${PACKS}/version-control/prsPanel.tsx`
  ));
  if (HAS_BROWSER) {
    ({ AnnotateButton, ScreenshotButton } = await import(
      /* @vite-ignore */ `${PACKS}/browser/annotateButton.tsx`
    ));
  }
});

const host = { React, tooltip: hostTooltip } as unknown as ClientHost;

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

async function render(node: React.ReactNode) {
  await act(async () => root.render(<TooltipProvider delay={0}>{node}</TooltipProvider>));
}

function button() {
  const element = container.querySelector("button");
  if (!element) throw new Error("Control was not rendered");
  return element;
}

function popupText(): string | null {
  return document.querySelector('[data-slot="tooltip-popup"]')?.textContent ?? null;
}

/**
 * Moves the pointer onto the control. Enter events do not bubble, so each
 * element the pointer enters gets its own, innermost first; a disabled
 * button takes no pointer events, so the pointer lands on its parent.
 */
async function hoverControl() {
  const entered: Element[] = [];
  for (
    let node: Element | null = button().disabled ? button().parentElement : button();
    node && node !== container;
    node = node.parentElement
  ) {
    entered.push(node);
  }
  await act(async () => {
    for (const target of entered) {
      target.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
      target.dispatchEvent(new MouseEvent("mouseenter"));
    }
    entered[0]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  await act(async () => {});
}

describe("version-control header actions", () => {
  async function renderAction(
    action: PrsWriteActionKind,
    state: { disabled: boolean; pendingAction: string | null; method?: string },
  ) {
    await render(
      <PrsActionButton
        host={host}
        offer={{ action, label: action, destructive: false }}
        disabled={state.disabled}
        pendingAction={state.pendingAction}
        method={state.method ?? ""}
        onMethodChange={() => {}}
        onRun={() => {}}
      />,
    );
  }

  const cases: ReadonlyArray<{
    action: PrsWriteActionKind;
    method?: string;
    idle: string;
    running: string;
  }> = [
    { action: "ready", idle: "Ready for review", running: "Ready for review" },
    { action: "merge", method: "squash", idle: "Squash and merge", running: "Merging..." },
    {
      action: "enable-auto-merge",
      method: "rebase",
      idle: "Auto-merge (rebase and merge)",
      running: "Enabling...",
    },
    { action: "approve-workflows", idle: "Approve workflows to run", running: "Approving..." },
  ];

  for (const { action, method, idle, running } of cases) {
    it(`${action}: native name and hover help enabled, own-pending and other-pending`, async () => {
      const states = [
        { disabled: false, pendingAction: null, expected: idle },
        { disabled: true, pendingAction: action, expected: running },
        { disabled: true, pendingAction: "close", expected: idle },
      ];
      for (const { disabled, pendingAction, expected } of states) {
        await render(null);
        await renderAction(action, { disabled, pendingAction, ...(method ? { method } : {}) });
        expect(button().disabled).toBe(disabled);
        expect(button().textContent).toBe(expected);
        await hoverControl();
        expect(popupText()).toBe(expected);
      }
    });
  }

  it("keeps plain menu actions silent while another write runs", async () => {
    await renderAction("close", { disabled: true, pendingAction: "merge" });
    expect(button().textContent).toBe("Close");
    await hoverControl();
    expect(popupText()).toBeNull();
  });
});

describe("version-control list row", () => {
  const entry = {
    provider: "github",
    host: "github.com",
    projectId: "project",
    projectTitle: "App",
    repository: "acme/app",
    number: 123,
    title: "Stack layer",
    state: "open",
    isDraft: false,
    author: { login: "alex" },
    additions: 1,
    deletions: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    labels: [],
    checksState: "passing",
    stack: { number: 120, position: 2, size: 3, base: "main" },
  } as unknown as PrsListEntry;

  function badge(text: string) {
    const element = [...container.querySelectorAll("span")].find((e) => e.textContent === text);
    if (!element) throw new Error(`${text} badge was not rendered`);
    return element;
  }

  async function hoverBadge(text: string) {
    const target = badge(text);
    await act(async () => {
      target.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
      target.dispatchEvent(new MouseEvent("mouseenter"));
      target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    await act(async () => {});
  }

  it("explains a GitHub stack membership on hover, as native does", async () => {
    await render(<PrListRow host={host} entry={entry} viewers={{}} onSelect={() => {}} />);
    await hoverBadge("Stack 2/3 · main");
    expect(popupText()).toBe("GitHub stack of 3: merging a layer lands the ones below it.");
  });
});

describe.skipIf(!HAS_BROWSER)("browser annotate button", () => {
  const reason = "Page didn't load — pick unavailable until the page renders";

  async function renderAnnotate(state: { blockReason: string | null; pageFailed: boolean }) {
    await render(
      <AnnotateButton host={host} capturing={null} onPick={() => {}} style={{}} {...state} />,
    );
  }

  it("disables a failed page on a supported host and explains why on hover", async () => {
    await renderAnnotate({ blockReason: reason, pageFailed: true });
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-label")).toBe("Annotate preview");
    await hoverControl();
    expect(popupText()).toBe(reason);
  });

  it("offers annotation on a rendered page", async () => {
    await renderAnnotate({ blockReason: null, pageFailed: false });
    expect(button().disabled).toBe(false);
    await hoverControl();
    expect(popupText()).toBe("Annotate elements, regions, and drawings");
  });

  it("stays enabled while picking, so pressing it again cancels", async () => {
    const onPick = vi.fn();
    await render(
      <AnnotateButton
        host={host}
        blockReason={null}
        capturing="element"
        pageFailed={false}
        onPick={onPick}
        style={{}}
      />,
    );
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-label")).toBe("Cancel annotation");
    await act(async () => button().click());
    expect(onPick).toHaveBeenCalledOnce();
    await hoverControl();
    expect(popupText()).toBe("Cancel annotation (Esc)");
  });

  it("stays silent when capture itself is unavailable", async () => {
    await renderAnnotate({ blockReason: "Open a page to capture it.", pageFailed: false });
    expect(button().disabled).toBe(true);
    await hoverControl();
    expect(popupText()).toBeNull();
  });
});

describe.skipIf(!HAS_BROWSER)("browser screenshot button", () => {
  const failed = "Page didn't load — pick unavailable until the page renders";

  async function renderScreenshot(state: { blockReason: string | null; pageFailed: boolean }) {
    await render(
      <ScreenshotButton host={host} capturing={null} onCapture={() => {}} style={{}} {...state} />,
    );
  }

  it("disables a failed page without borrowing the pick control's reason, as native does", async () => {
    await renderScreenshot({ blockReason: failed, pageFailed: true });
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-label")).toBe("Capture screenshot");
    expect(button().hasAttribute("aria-description")).toBe(false);
  });

  it("still names why capture is unavailable for other blocks", async () => {
    await renderScreenshot({ blockReason: "Open a page to capture it.", pageFailed: false });
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-description")).toBe("Open a page to capture it.");
  });

  it("offers a screenshot on a rendered page", async () => {
    await renderScreenshot({ blockReason: null, pageFailed: false });
    expect(button().disabled).toBe(false);
    await hoverControl();
    expect(popupText()).toBe("Screenshot");
  });
});
