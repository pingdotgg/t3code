import { isValidElement, type ReactElement } from "react";
import { LayersIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";

import { MenuItem, MenuRadioItem, MenuSeparator } from "../ui/menu";
import { TooltipPopup } from "../ui/tooltip";
import { IssueSortMenu, renderIssueProviderMenuRadioGroup } from "./IssueListFilters";

function collect(
  node: unknown,
  type: ReactElement["type"],
): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, type));
  if (!isValidElement<Record<string, unknown>>(node)) return [];

  const found = node.type === type ? [node] : [];
  for (const value of Object.values(node.props)) {
    found.push(...collect(value, type));
  }
  return found;
}

describe("issue filters", () => {
  it("does not reset the list scope when the current provider is selected again", () => {
    const onChange = vi.fn();
    const group = renderIssueProviderMenuRadioGroup({
      value: "linear.app",
      options: [],
      onChange,
    });

    group.props.onValueChange("linear.app");
    expect(onChange).not.toHaveBeenCalled();
    group.props.onValueChange("");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("");
  });

  it("keeps basic sorting available without GitHub reactions", () => {
    const menu = IssueSortMenu({
      sort: "updated",
      order: "desc",
      reactionsAvailable: false,
      onSort: vi.fn(),
      onOrder: vi.fn(),
    });
    expect(collect(menu, MenuRadioItem).map((item) => item.props.value)).toEqual([
      "created",
      "updated",
      "comments",
      "best-match",
      "asc",
      "desc",
    ]);
  });

  it("hides ineffective order choices for best-match sorting", () => {
    const menu = IssueSortMenu({
      sort: "best-match",
      order: "desc",
      onSort: vi.fn(),
      onOrder: vi.fn(),
    });
    const orderChoices = collect(menu, MenuRadioItem).filter(
      (item) => item.props.value === "asc" || item.props.value === "desc",
    );

    expect(orderChoices).toHaveLength(0);
    expect(collect(menu, MenuSeparator)).toHaveLength(0);
  });

  it("uses styled help for unavailable providers and Linear settings", () => {
    const group = renderIssueProviderMenuRadioGroup({
      value: "",
      options: [
        {
          value: "gitlab.com",
          label: "GitLab",
          Icon: LayersIcon,
          unavailable: "Not authenticated",
        },
        { value: "linear.app", label: "Linear", Icon: LayersIcon },
      ],
      onChange: vi.fn(),
      onManageLinear: vi.fn(),
    });
    const popups = collect(group, TooltipPopup).map((popup) => popup.props.children);
    const items = collect(group, MenuRadioItem);
    const settings = collect(group, MenuItem).find(
      (item) => item.props["aria-label"] === "Linear settings",
    );

    expect(popups).toEqual(expect.arrayContaining(["Not authenticated", "Linear settings"]));
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.props.title === undefined)).toBe(true);
    expect(settings).toBeDefined();
    expect(settings?.props.title).toBeUndefined();
  });
});
