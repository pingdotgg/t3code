import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CircleIcon } from "lucide-react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestFiltersMenu, pullRequestProjectKey } from "./PullRequestListFilters";

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

/** The nested radio-group component element carrying this label, invoked so its group shows. */
function findLabeledGroup(node: ReactNode, label: string): ReactNode {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as { readonly children?: ReactNode; readonly label?: string };
    if (props.label === label && typeof child.type === "function") {
      return (child.type as (properties: unknown) => ReactNode)(child.props);
    }
    const nested = findLabeledGroup(props.children, label);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

interface CheckboxItemProps {
  readonly checked?: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly onClick?: () => void;
  readonly children?: ReactNode;
}

/** The project rows, in the order the menu lists them: "All projects" first, then the projects. */
function findCheckboxItems(node: ReactNode): ReadonlyArray<CheckboxItemProps> {
  const found: CheckboxItemProps[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as CheckboxItemProps;
    if (typeof props.checked === "boolean") found.push(props);
    found.push(...findCheckboxItems(props.children));
  }
  return found;
}

/** The per-row "Only" buttons, in the same order as the rows that carry them. */
function findOnlyButtons(
  node: ReactNode,
): ReadonlyArray<{ readonly onClick: (event: unknown) => void }> {
  const found: Array<{ readonly onClick: (event: unknown) => void }> = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as {
      readonly children?: ReactNode;
      readonly onClick?: (event: unknown) => void;
    };
    if (child.type === "button" && props.onClick) found.push({ onClick: props.onClick });
    found.push(...findOnlyButtons(props.children));
  }
  return found;
}

/** Enough of a click for the handler, which only ever stops the row from swallowing it. */
const clickEvent = () => ({ preventDefault: () => undefined, stopPropagation: () => undefined });

function menu(overrides: Partial<Parameters<typeof PullRequestFiltersMenu>[0]>) {
  return PullRequestFiltersMenu({
    state: "open",
    stateOptions: [
      { value: "open", label: "Open", Icon: CircleIcon },
      { value: "closed", label: "Closed", Icon: CircleIcon },
    ],
    onState: () => undefined,
    involvement: "all",
    involvementOptions: [{ value: "all", label: "All", Icon: CircleIcon }],
    onInvolvement: () => undefined,
    filters: {},
    onFilters: () => undefined,
    host: undefined,
    hostOptions: [],
    onHost: () => undefined,
    hiddenProjectKeys: [],
    onHiddenProjectKeys: () => undefined,
    server: undefined,
    serverOptions: [],
    onServer: () => undefined,
    projects: [],
    projectId: undefined,
    projectEnvironmentId: undefined,
    unavailable: new Map(),
    onProject: () => undefined,
    ...overrides,
  });
}

describe("pull request filters menu", () => {
  const projectOne = {
    id: "project-1" as ProjectId,
    environmentId: "env-1" as EnvironmentId,
    title: "T3 Code",
    workspaceRoot: "/work/t3code",
  };
  const projectTwo = {
    id: "project-2" as ProjectId,
    environmentId: "env-1" as EnvironmentId,
    title: "Popular OSS",
    workspaceRoot: "/work/popular",
  };
  const keyTwo = pullRequestProjectKey(projectTwo);

  it("does not emit a change when the selected state is chosen again", () => {
    const onState = vi.fn();
    const group = findValueChange(findLabeledGroup(menu({ onState }), "State"));
    expect(group).toBeDefined();

    group?.props.onValueChange("open");
    expect(onState).not.toHaveBeenCalled();

    group?.props.onValueChange("closed");
    expect(onState).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith("closed");
  });

  it("names the chosen narrowing and leaves the others alone", () => {
    const onFilters = vi.fn();
    const group = findValueChange(
      findLabeledGroup(menu({ filters: { review: "approved" }, onFilters }), "Draft"),
    );
    expect(group).toBeDefined();

    group?.props.onValueChange("hide");
    expect(onFilters).toHaveBeenCalledWith({ review: "approved", draft: "hide" });
  });

  it("drops a narrowing chosen back to all rather than sending it as undefined", () => {
    const onFilters = vi.fn();
    const group = findValueChange(
      findLabeledGroup(
        menu({ filters: { review: "none", checks: "failing" }, onFilters }),
        "Review",
      ),
    );
    expect(group).toBeDefined();

    group?.props.onValueChange("all");
    expect(onFilters).toHaveBeenCalledWith({ checks: "failing" });
  });

  it("hides a project when its row is unchecked", () => {
    const onHiddenProjectKeys = vi.fn();
    const rows = findCheckboxItems(
      menu({ projects: [projectOne, projectTwo], onHiddenProjectKeys }),
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.checked)).toEqual([true, true, true]);

    rows[2]?.onCheckedChange?.(false);
    expect(onHiddenProjectKeys).toHaveBeenCalledWith([keyTwo]);
  });

  it("brings a hidden project back when its row is checked again", () => {
    const onHiddenProjectKeys = vi.fn();
    const rows = findCheckboxItems(
      menu({
        projects: [projectOne, projectTwo],
        hiddenProjectKeys: [keyTwo],
        onHiddenProjectKeys,
      }),
    );
    expect(rows.map((row) => row.checked)).toEqual([false, true, false]);

    rows[2]?.onCheckedChange?.(true);
    expect(onHiddenProjectKeys).toHaveBeenCalledWith([]);
  });

  it("reads a one-project scope as that project alone being listed", () => {
    const rows = findCheckboxItems(
      menu({
        projects: [projectOne, projectTwo],
        projectId: projectOne.id,
        projectEnvironmentId: projectOne.environmentId,
      }),
    );
    expect(rows.map((row) => row.checked)).toEqual([false, true, false]);
  });

  it("carries a one-project scope into the hidden set rather than discarding it", () => {
    const onProject = vi.fn();
    const onHiddenProjectKeys = vi.fn();
    const rows = findCheckboxItems(
      menu({
        projects: [projectOne, projectTwo],
        projectId: projectOne.id,
        projectEnvironmentId: projectOne.environmentId,
        onProject,
        onHiddenProjectKeys,
      }),
    );

    rows[2]?.onCheckedChange?.(true);
    expect(onProject).toHaveBeenCalledWith(undefined, undefined);
    expect(onHiddenProjectKeys).toHaveBeenCalledWith([]);
  });

  it("clears both the scope and the hidden set when all projects is chosen", () => {
    const onProject = vi.fn();
    const onHiddenProjectKeys = vi.fn();
    const rows = findCheckboxItems(
      menu({
        projects: [projectOne, projectTwo],
        projectId: projectOne.id,
        projectEnvironmentId: projectOne.environmentId,
        hiddenProjectKeys: [keyTwo],
        onProject,
        onHiddenProjectKeys,
      }),
    );

    rows[0]?.onClick?.();
    expect(onProject).toHaveBeenCalledWith(undefined, undefined);
    expect(onHiddenProjectKeys).toHaveBeenCalledWith([]);
  });

  it("narrows to one project from its own row, environment and all", () => {
    const onProject = vi.fn();
    const duplicate = { ...projectTwo, id: projectOne.id, environmentId: "env-2" as EnvironmentId };
    const buttons = findOnlyButtons(menu({ projects: [projectOne, duplicate], onProject }));
    expect(buttons).toHaveLength(2);

    buttons[1]?.onClick(clickEvent());
    expect(onProject).toHaveBeenCalledWith(projectOne.id, "env-2");
  });

  it("does not collide when environment and project ids contain spaces", () => {
    expect(
      pullRequestProjectKey({
        environmentId: "a b" as EnvironmentId,
        id: "c" as ProjectId,
      }),
    ).not.toBe(
      pullRequestProjectKey({
        environmentId: "a" as EnvironmentId,
        id: "b c" as ProjectId,
      }),
    );
  });
});
