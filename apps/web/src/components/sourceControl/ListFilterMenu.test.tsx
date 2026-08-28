import type { ProjectId } from "@t3tools/contracts";
import { CircleIcon } from "lucide-react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DetailTabStrip } from "./DetailTabStrip";
import { EntityPicker } from "./EntityPicker";
import {
  ListFilterMenu,
  ListFilterRadioGroup,
  ListProjectFilterGroup,
  ListSearchInput,
} from "./ListFilterMenu";
import { DetailGhost } from "./ListGhosts";
import { SummaryMetaRow } from "./SummaryMetaRow";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

function findValueChange(
  node: ReactNode,
):
  | ReactElement<{ readonly children?: ReactNode; readonly onValueChange: (value: string) => void }>
  | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as {
      readonly children?: ReactNode;
      readonly onValueChange?: (value: string) => void;
    };
    if (props.onValueChange) {
      return child as ReactElement<{
        readonly children?: ReactNode;
        readonly onValueChange: (value: string) => void;
      }>;
    }
    const nested = findValueChange(props.children);
    if (nested) return nested;
  }
  return undefined;
}

describe("list filter menu", () => {
  it("uses the shared outline button for list filters", () => {
    const menu = ListFilterMenu({ label: "Filter issues", filtered: true, children: null });
    const trigger = Children.toArray(menu.props.children)[0] as ReactElement<{
      readonly render: ReactElement<{ readonly className?: string; size: string; variant: string }>;
    }>;

    expect(trigger.props.render).toBeDefined();
    const button = trigger.props.render;
    if (!button) return;
    expect(button.type).toBe(Button);
    expect(button.props).toMatchObject({ size: "icon", variant: "outline" });
    expect(button.props.className).toContain("--control-icon-color");
  });

  it("keeps summary values aligned in a fixed label grid", () => {
    const markup = renderToStaticMarkup(
      <SummaryMetaRow icon={<CircleIcon />} label="Assignees">
        Nobody
      </SummaryMetaRow>,
    );

    expect(markup).toContain("grid-cols-[6rem_minmax(0,1fr)]");
  });

  it("loads issue details in the same full panel shape", () => {
    const markup = renderToStaticMarkup(<DetailGhost label="Loading issue" />);

    expect(markup).toContain("flex h-full min-h-0 flex-col");
    expect(markup).toContain("border-b border-border/60");
    expect(markup).toContain("grid-cols-[6rem_minmax(0,1fr)]");
  });

  it("keeps the accessible search label separate from its hint", () => {
    const input = ListSearchInput({
      label: "Search pull requests",
      placeholder: "Search pull requests, or label:bug",
      value: "",
      onChange: vi.fn(),
    });
    const field = Children.toArray(input.props.children).find(
      (child) =>
        isValidElement(child) &&
        (child.props as { readonly "aria-label"?: string })["aria-label"] ===
          "Search pull requests",
    ) as ReactElement<{
      readonly "aria-label": string;
      readonly placeholder: string;
      readonly type: string;
    }>;

    expect(field.props["aria-label"]).toBe("Search pull requests");
    expect(field.props.placeholder).toBe("Search pull requests, or label:bug");
    expect(field.props.type).toBe("search");
  });

  it("uses the compact input primitive in entity pickers", () => {
    const picker = EntityPicker({
      icon: null,
      label: "Assign people",
      allowed: true,
      disallowedReason: "Unavailable",
      open: true,
      onOpenChange: vi.fn(),
      searchLabel: "Search people",
      query: "",
      onQueryChange: vi.fn(),
      message: null,
      note: null,
      children: null,
    });
    const popup = Children.toArray(picker.props.children).find(
      (child) =>
        isValidElement(child) &&
        (child.props as { readonly className?: string }).className === "w-72 p-0",
    ) as ReactElement<{ readonly children: ReactNode }>;
    const frame = Children.toArray(popup.props.children)[0] as ReactElement<{
      readonly children: ReactNode;
    }>;
    const field = Children.only(frame.props.children) as ReactElement<{
      readonly "aria-label": string;
      readonly size: string;
    }>;

    expect(field.type).not.toBe("input");
    expect(field.props["aria-label"]).toBe("Search people");
    expect(field.props.size).toBe("compact");
  });

  it("hides the native scrollbar on detail tabs", () => {
    const onSelect = vi.fn();
    const strip = DetailTabStrip({
      label: "Pull request tabs",
      tabs: [
        { value: "summary", label: "Summary" },
        { value: "timeline", label: "Timeline" },
      ],
      active: "summary",
      onSelect,
    });
    const group = Children.toArray(strip.props.children)[0] as ReactElement<{
      readonly children: ReactNode;
      readonly onValueChange: (value: ReadonlyArray<string>) => void;
      readonly size: string;
      readonly variant: string;
    }>;
    const toggles = Children.toArray(group.props.children) as ReadonlyArray<ReactElement>;

    expect(strip.props.className).toContain("[scrollbar-width:none]");
    expect(strip.props.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(group.type).toBe(ToggleGroup);
    expect(group.props).toMatchObject({ size: "segmented", variant: "segmented" });
    expect(toggles.every((toggle) => toggle.type === Toggle)).toBe(true);
    group.props.onValueChange(["timeline"]);
    expect(onSelect).toHaveBeenCalledWith("timeline");
  });

  it("does not emit a change when the selected option is chosen again", () => {
    const onChange = vi.fn();
    const group = findValueChange(
      ListFilterRadioGroup({
        label: "State",
        value: "open",
        options: [
          { value: "open", label: "Open", Icon: CircleIcon },
          { value: "closed", label: "Closed", Icon: CircleIcon },
        ],
        onChange,
      }),
    );
    expect(group).toBeDefined();

    group?.props.onValueChange("open");
    expect(onChange).not.toHaveBeenCalled();

    group?.props.onValueChange("closed");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("closed");
  });

  it("does not emit a change when the selected project is chosen again", () => {
    const projectId = "project-1" as ProjectId;
    const onProject = vi.fn();
    const group = findValueChange(
      ListProjectFilterGroup({
        environmentId: null,
        projects: [{ id: projectId, title: "T3 Code", workspaceRoot: "/work/t3code" }],
        projectId,
        unavailable: new Map(),
        onProject,
      }),
    );
    expect(group).toBeDefined();

    group?.props.onValueChange(projectId);
    expect(onProject).not.toHaveBeenCalled();

    group?.props.onValueChange("all");
    expect(onProject).toHaveBeenCalledWith(undefined);
  });
});
