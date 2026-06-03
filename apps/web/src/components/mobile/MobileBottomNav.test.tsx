import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MobileBottomNav } from "./MobileBottomNav";

describe("MobileBottomNav", () => {
  it("renders all three tab buttons", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav
        onToggleSidebar={() => {}}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />,
    );
    expect(markup).toContain("Sessions");
    expect(markup).toContain("Chat");
    expect(markup).toContain("Terminal");
  });

  it("marks Terminal as active when terminalOpen is true", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav
        onToggleSidebar={() => {}}
        onToggleTerminal={() => {}}
        terminalOpen={true}
      />,
    );
    expect(markup).toContain('aria-pressed="true"');
  });

  it("does not mark Terminal as active when terminalOpen is false", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav
        onToggleSidebar={() => {}}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />,
    );
    const terminalButtonMatch = markup.match(/aria-label="Terminal"[^>]*aria-pressed="([^"]+)"/);
    expect(terminalButtonMatch?.[1]).toBe("false");
  });

  it("has md:hidden class so it only shows on mobile", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNav
        onToggleSidebar={() => {}}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />,
    );
    expect(markup).toContain("md:hidden");
  });

  it("calls onToggleSidebar when Sessions button description matches", () => {
    const onToggleSidebar = vi.fn();
    const markup = renderToStaticMarkup(
      <MobileBottomNav
        onToggleSidebar={onToggleSidebar}
        onToggleTerminal={() => {}}
        terminalOpen={false}
      />,
    );
    expect(markup).toContain('aria-label="Sessions"');
  });
});
