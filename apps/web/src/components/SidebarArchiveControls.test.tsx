import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarSettledDivider, SidebarSettledLifecycleControls } from "./SidebarArchiveControls";

type ClickableElement = ReactElement<{
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
  readonly onClick?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
  readonly render?: ReactNode;
}>;

function includesText(node: ReactNode, text: string): boolean {
  if (node === text) return true;
  if (Array.isArray(node)) return node.some((child) => includesText(child, text));
  if (!isValidElement(node)) return false;
  return includesText((node as ClickableElement).props.children, text);
}

function findButton(node: ReactNode, ariaLabel: string): ClickableElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, ariaLabel);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ClickableElement;
  if (element.type === "button" && element.props["aria-label"] === ariaLabel) return element;
  const renderedButton = findButton(element.props.render, ariaLabel);
  if (renderedButton) return renderedButton;
  return findButton(element.props.children, ariaLabel);
}

describe("SidebarSettledLifecycleControls", () => {
  it("renders adjacent un-settle and archive controls for supported settled rows", () => {
    const controls = SidebarSettledLifecycleControls({
      settlementSupported: true,
      archiveDisabled: false,
      preserveWokeStatus: false,
      onUnsettle: vi.fn(),
      onArchive: vi.fn(),
    });
    const markup = renderToStaticMarkup(controls);

    expect(markup).toContain('aria-label="Un-settle thread"');
    expect(markup).toContain('aria-label="Archive thread"');
    expect(includesText(controls, "Archive thread")).toBe(true);
    expect(markup).toContain("group-hover/sidebar-row:pointer-events-auto");
    expect(markup).toContain("has-[:focus-visible]:opacity-100");
  });

  it("keeps a blocked archive control mounted and pointer-targetable", () => {
    const onArchive = vi.fn();
    const controls = SidebarSettledLifecycleControls({
      settlementSupported: false,
      archiveDisabled: true,
      preserveWokeStatus: true,
      onUnsettle: vi.fn(),
      onArchive,
    });
    const markup = renderToStaticMarkup(controls);
    const archiveButton = findButton(controls, "Archive unavailable while work is still active");
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    archiveButton?.props.onClick?.({ preventDefault, stopPropagation });

    expect(markup).not.toContain('aria-label="Un-settle thread"');
    expect(markup).toContain('aria-label="Archive unavailable while work is still active"');
    expect(markup).not.toContain("title=");
    expect(markup).toContain('data-slot="tooltip-trigger"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("aria-disabled:cursor-not-allowed");
    expect(markup).toContain("aria-disabled:hover:text-muted-foreground");
    expect(includesText(controls, "Cannot archive while work is still active")).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onArchive).not.toHaveBeenCalled();
    expect(markup).toContain("group-hover/sidebar-row:static");
  });
});

describe("SidebarSettledDivider", () => {
  it("renders the complete settled count and archive-all scope when collapsed", () => {
    const markup = renderToStaticMarkup(
      <SidebarSettledDivider
        archivableCount={3}
        settledCount={5}
        expanded={false}
        isArchiving={false}
        onToggle={vi.fn()}
        onArchiveAll={vi.fn()}
      />,
    );

    expect(markup).toContain("Settled (5)");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Archive all 3 settled threads"');
    expect(markup).toContain("Archive all");
  });

  it("keeps the in-flight archive-all control mounted after optimistic removal", () => {
    const markup = renderToStaticMarkup(
      <SidebarSettledDivider
        archivableCount={0}
        settledCount={1}
        expanded
        isArchiving
        onToggle={vi.fn()}
        onArchiveAll={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Archiving settled threads"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("Archive all");
  });

  it("isolates archive-all clicks from the shelf toggle", () => {
    const onArchiveAll = vi.fn();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const divider = SidebarSettledDivider({
      archivableCount: 1,
      settledCount: 1,
      expanded: true,
      isArchiving: false,
      onToggle: vi.fn(),
      onArchiveAll,
    });

    findButton(divider, "Archive all 1 settled thread")?.props.onClick?.({
      preventDefault,
      stopPropagation,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onArchiveAll).toHaveBeenCalledOnce();
  });

  it("omits archive all when there is no eligible work or active batch", () => {
    const markup = renderToStaticMarkup(
      <SidebarSettledDivider
        archivableCount={0}
        settledCount={2}
        expanded
        isArchiving={false}
        onToggle={vi.fn()}
        onArchiveAll={vi.fn()}
      />,
    );

    expect(markup).not.toContain("Archive all");
  });
});
