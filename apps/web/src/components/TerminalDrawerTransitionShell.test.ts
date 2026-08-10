import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TerminalDrawerTransitionShell } from "./TerminalDrawerTransitionShell";

function renderTerminalDrawerShell(
  options?: Partial<
    Pick<
      ComponentProps<typeof TerminalDrawerTransitionShell>,
      "active" | "animateEnter" | "height" | "open" | "resizing"
    >
  >,
): string {
  const props: ComponentProps<typeof TerminalDrawerTransitionShell> = {
    active: options?.active ?? true,
    animateEnter: options?.animateEnter ?? true,
    height: options?.height ?? 320,
    open: options?.open ?? true,
    resizing: options?.resizing ?? false,
    onExitComplete: () => undefined,
    children: createElement("div", null, "Terminal content"),
  };
  return renderToStaticMarkup(TerminalDrawerTransitionShell(props));
}

describe("TerminalDrawerTransitionShell", () => {
  it("isolates the fixed-height terminal surface from the animated layout gap", () => {
    const html = renderTerminalDrawerShell();

    expect(html).toContain("terminal-drawer-inline-gap");
    expect(html).toContain("terminal-drawer-inline-surface");
    expect(html).toContain("overflow-clip");
    expect(html).toContain("--terminal-drawer-height:320px");
    expect(html).toContain('data-terminal-drawer-open="true"');
  });

  it("keeps the closing terminal mounted but non-interactive", () => {
    const html = renderTerminalDrawerShell({ open: false });

    expect(html).toContain('data-terminal-drawer-open="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
    expect(html).toContain("Terminal content");
  });

  it("disables layout motion while the drawer is being resized", () => {
    const html = renderTerminalDrawerShell({ resizing: true });

    expect(html).toContain('data-terminal-drawer-resizing="true"');
  });

  it("keeps inactive thread terminals mounted and hidden", () => {
    const html = renderTerminalDrawerShell({ active: false });

    expect(html).toContain("terminal-drawer-inline-frame hidden");
    expect(html).toContain('data-terminal-drawer-active="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("Terminal content");
  });

  it("can reveal a retained terminal without replaying its enter animation", () => {
    const html = renderTerminalDrawerShell({ animateEnter: false });

    expect(html).toContain('data-terminal-drawer-open="true"');
    expect(html).not.toContain("data-terminal-drawer-animate-enter");
  });
});
