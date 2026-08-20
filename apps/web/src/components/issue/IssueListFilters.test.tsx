import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { LayersIcon, SettingsIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";

import { ListFilterRadioGroup } from "../sourceControl/ListFilterMenu";
import { LinearIcon } from "../Icons";
import { Button } from "../ui/button";
import { MenuItem, MenuRadioItem, MenuSeparator } from "../ui/menu";
import { IssueFiltersMenu, IssueSortMenu } from "./IssueListFilters";

function collect(
  node: ReactNode,
  type: ReactElement["type"],
): Array<ReactElement<Record<string, unknown>>> {
  const found: Array<ReactElement<Record<string, unknown>>> = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    if (child.type === type) found.push(child as ReactElement<Record<string, unknown>>);
    found.push(...collect((child.props as { children?: ReactNode }).children, type));
  }
  return found;
}

describe("issue filters", () => {
  it("uses the shared outline button for sorting", () => {
    const menu = IssueSortMenu({
      sort: "updated",
      order: "desc",
      onSort: vi.fn(),
      onOrder: vi.fn(),
    });
    const trigger = Children.toArray(menu.props.children)[0] as ReactElement<{
      readonly render?: ReactElement<{ readonly size: string; readonly variant: string }>;
    }>;

    expect(trigger.props.render).toBeDefined();
    if (!trigger.props.render) return;
    expect(trigger.props.render.type).toBe(Button);
    expect(trigger.props.render.props).toMatchObject({ size: "icon", variant: "outline" });
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

  it("shows only connected providers and keeps All providers selected by default", () => {
    const menu = IssueFiltersMenu({
      state: "open",
      stateOptions: [],
      onState: vi.fn(),
      involvement: "all",
      involvementOptions: [],
      onInvolvement: vi.fn(),
      hostFilter: {
        host: undefined,
        hostOptions: [
          { value: "", label: "All providers", Icon: LayersIcon },
          { value: "github.com", label: "GitHub", Icon: LayersIcon },
          {
            value: "gitlab.com",
            label: "GitLab",
            Icon: LayersIcon,
            unavailable: "Not authenticated",
          },
        ],
        onHost: vi.fn(),
        onManageLinear: vi.fn(),
      },
      label: undefined,
      labels: [],
      onLabel: vi.fn(),
    } as Parameters<typeof IssueFiltersMenu>[0]);

    const providerGroup = collect(menu, ListFilterRadioGroup).find(
      (item) => item.props.label === "Provider",
    );
    expect(providerGroup?.props.value).toBe("");
    expect(
      (providerGroup?.props.options as ReadonlyArray<{ value: string }> | undefined)?.map(
        (item) => item.value,
      ),
    ).toEqual(["", "github.com"]);
    const connectItem = collect(menu, MenuItem)[0];
    expect(Children.toArray(connectItem?.props.children as ReactNode)).toContain("Connect Linear…");
    expect(collect(connectItem, LinearIcon)).toHaveLength(1);
  });

  it("uses saved connection state for management copy when the provider list is stale", () => {
    const menu = IssueFiltersMenu({
      state: "open",
      stateOptions: [],
      onState: vi.fn(),
      involvement: "all",
      involvementOptions: [],
      onInvolvement: vi.fn(),
      hostFilter: {
        host: undefined,
        hostOptions: [
          { value: "", label: "All providers", Icon: LayersIcon },
          { value: "github.com", label: "GitHub", Icon: LayersIcon },
        ],
        onHost: vi.fn(),
        onManageLinear: vi.fn(),
        linearManaged: true,
      },
      label: undefined,
      labels: [],
      onLabel: vi.fn(),
    } as Parameters<typeof IssueFiltersMenu>[0]);

    const settingsItem = collect(menu, MenuItem)[0];
    expect(Children.toArray(settingsItem?.props.children as ReactNode)).toContain(
      "Linear settings…",
    );
    expect(collect(settingsItem, LinearIcon)).toHaveLength(1);
  });

  it("offers a separate keyboard-navigable menu action beside connected Linear", () => {
    const onManageLinear = vi.fn();
    const menu = IssueFiltersMenu({
      state: "open",
      stateOptions: [],
      onState: vi.fn(),
      involvement: "all",
      involvementOptions: [],
      onInvolvement: vi.fn(),
      hostFilter: {
        host: undefined,
        hostOptions: [
          { value: "", label: "All providers", Icon: LayersIcon },
          { value: "linear.app", label: "Linear", Icon: LayersIcon },
        ],
        onHost: vi.fn(),
        onManageLinear,
      },
      label: undefined,
      labels: [],
      onLabel: vi.fn(),
    } as Parameters<typeof IssueFiltersMenu>[0]);

    const gear = collect(menu, MenuItem).find(
      (candidate) => candidate.props["aria-label"] === "Linear settings",
    );
    const linearRadio = collect(menu, MenuRadioItem).find(
      (candidate) => candidate.props.value === "linear.app",
    );
    expect(gear).toBeDefined();
    expect(collect(gear, SettingsIcon)).toHaveLength(1);
    expect(collect(linearRadio, MenuItem)).toHaveLength(0);
    (gear?.props.onClick as (() => void) | undefined)?.();
    expect(onManageLinear).toHaveBeenCalledOnce();
  });
});
