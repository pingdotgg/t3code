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
  readonly onKeyDown?: (event: unknown) => void;
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

/**
 * Enough of a key press for the row handler. `preventBaseUIHandler` is the one the menu reads:
 * a handler that only prevents the default still lets the row toggle after it.
 */
const keyEvent = (key: string, shiftKey: boolean) => ({
  key,
  shiftKey,
  preventDefault: () => undefined,
  preventBaseUIHandler: vi.fn(),
});

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
    onProjectSelection: () => undefined,
    server: undefined,
    serverOptions: [],
    onServer: () => undefined,
    projects: [],
    projectId: undefined,
    projectEnvironmentId: undefined,
    unavailable: new Map(),
    ...overrides,
  });
}

describe("pull request filters menu", () => {
  const projectOne = {
    id: "project-1" as ProjectId,
    environmentId: "env-1" as EnvironmentId,
    title: "T3 Code",
    workspaceRoot: "/work/t3code",
    hideKey: "repository:github.com/acme/t3code",
  };
  const projectTwo = {
    id: "project-2" as ProjectId,
    environmentId: "env-1" as EnvironmentId,
    title: "Popular OSS",
    workspaceRoot: "/work/popular",
    hideKey: "repository:github.com/acme/popular",
  };
  const keyTwo = projectTwo.hideKey;
  /** The same repository held by a second server, so both rows share one hidden state. */
  const projectTwoElsewhere = {
    ...projectTwo,
    id: "project-9" as ProjectId,
    environmentId: "env-2" as EnvironmentId,
    title: "Popular OSS · other",
  };

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
    const onProjectSelection = vi.fn();
    const rows = findCheckboxItems(
      menu({ projects: [projectOne, projectTwo], onProjectSelection }),
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.checked)).toEqual([true, true, true]);

    rows[2]?.onCheckedChange?.(false);
    expect(onProjectSelection).toHaveBeenCalledWith({
      projectId: undefined,
      environmentId: undefined,
      hiddenKeys: [keyTwo],
    });
  });

  it("brings a hidden project back when its row is checked again", () => {
    const onProjectSelection = vi.fn();
    const rows = findCheckboxItems(
      menu({
        projects: [projectOne, projectTwo],
        hiddenProjectKeys: [keyTwo],
        onProjectSelection,
      }),
    );
    expect(rows.map((row) => row.checked)).toEqual([false, true, false]);

    rows[2]?.onCheckedChange?.(true);
    expect(onProjectSelection).toHaveBeenCalledWith({
      projectId: undefined,
      environmentId: undefined,
      hiddenKeys: [],
    });
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

  it("drops a one-project scope and its hidden set in one selection", () => {
    const onProjectSelection = vi.fn();
    const rows = findCheckboxItems(
      menu({
        projects: [projectOne, projectTwo],
        projectId: projectOne.id,
        projectEnvironmentId: projectOne.environmentId,
        onProjectSelection,
      }),
    );

    rows[2]?.onCheckedChange?.(true);
    // One call, never a scope change followed by a hidden change: two updates would each rebuild
    // the URL from the committed one and the second would put the scope back.
    expect(onProjectSelection).toHaveBeenCalledOnce();
    expect(onProjectSelection).toHaveBeenCalledWith({
      projectId: undefined,
      environmentId: undefined,
      hiddenKeys: [],
    });
  });

  it("carries a one-project scope into the hidden set rather than discarding it", () => {
    const onProjectSelection = vi.fn();
    const third = {
      ...projectTwo,
      id: "project-3" as ProjectId,
      title: "Third",
      hideKey: "repository:github.com/acme/third",
    };
    const rows = findCheckboxItems(
      menu({
        projects: [projectOne, projectTwo, third],
        projectId: projectOne.id,
        projectEnvironmentId: projectOne.environmentId,
        onProjectSelection,
      }),
    );

    rows[2]?.onCheckedChange?.(true);
    expect(onProjectSelection).toHaveBeenCalledWith({
      projectId: undefined,
      environmentId: undefined,
      hiddenKeys: [third.hideKey],
    });
  });

  it("clears both the scope and the hidden set when all projects is chosen", () => {
    const onProjectSelection = vi.fn();
    const rows = findCheckboxItems(
      menu({
        projects: [projectOne, projectTwo],
        projectId: projectOne.id,
        projectEnvironmentId: projectOne.environmentId,
        hiddenProjectKeys: [keyTwo],
        onProjectSelection,
      }),
    );

    rows[0]?.onClick?.();
    expect(onProjectSelection).toHaveBeenCalledOnce();
    expect(onProjectSelection).toHaveBeenCalledWith({
      projectId: undefined,
      environmentId: undefined,
      hiddenKeys: [],
    });
  });

  it("does not emit a selection when nothing about it would change", () => {
    const onProjectSelection = vi.fn();
    const rows = findCheckboxItems(
      menu({ projects: [projectOne, projectTwo], onProjectSelection }),
    );

    rows[0]?.onClick?.();
    expect(onProjectSelection).not.toHaveBeenCalled();
  });

  it("narrows to one project from its own row, environment and all", () => {
    const onProjectSelection = vi.fn();
    const duplicate = {
      ...projectTwo,
      id: projectOne.id,
      environmentId: "env-2" as EnvironmentId,
      hideKey: "repository:github.com/acme/other",
    };
    const buttons = findOnlyButtons(
      menu({ projects: [projectOne, duplicate], onProjectSelection }),
    );
    expect(buttons).toHaveLength(2);

    buttons[1]?.onClick(clickEvent());
    expect(onProjectSelection).toHaveBeenCalledWith({
      projectId: projectOne.id,
      environmentId: "env-2",
      hiddenKeys: [],
    });
  });

  it("narrows to one project from the keyboard", () => {
    const onProjectSelection = vi.fn();
    const rows = findCheckboxItems(
      menu({ projects: [projectOne, projectTwo], onProjectSelection }),
    );

    // Arrow keys reach the row but never the button inside it, so the row carries the action.
    const event = keyEvent("Enter", true);
    rows[2]?.onKeyDown?.(event);
    expect(onProjectSelection).toHaveBeenCalledWith({
      projectId: projectTwo.id,
      environmentId: projectTwo.environmentId,
      hiddenKeys: [],
    });
    // Without this the row toggles as well and the later of the two selections is what sticks.
    expect(event.preventBaseUIHandler).toHaveBeenCalled();
  });

  it("leaves a plain enter to the row's own checkbox", () => {
    const onProjectSelection = vi.fn();
    const rows = findCheckboxItems(
      menu({ projects: [projectOne, projectTwo], onProjectSelection }),
    );

    rows[2]?.onKeyDown?.(keyEvent("Enter", false));
    rows[2]?.onKeyDown?.(keyEvent("o", false));
    expect(onProjectSelection).not.toHaveBeenCalled();
  });

  it("hides both copies of a repository two servers share", () => {
    const onProjectSelection = vi.fn();
    const rows = findCheckboxItems(
      menu({ projects: [projectTwo, projectTwoElsewhere], onProjectSelection }),
    );
    expect(rows.map((row) => row.checked)).toEqual([true, true, true]);

    rows[1]?.onCheckedChange?.(false);
    expect(onProjectSelection).toHaveBeenCalledWith({
      projectId: undefined,
      environmentId: undefined,
      hiddenKeys: [projectTwo.hideKey],
    });
  });

  it("reads both copies of a shared repository as hidden from the one key", () => {
    const rows = findCheckboxItems(
      menu({
        projects: [projectTwo, projectTwoElsewhere],
        hiddenProjectKeys: [projectTwo.hideKey],
      }),
    );
    expect(rows.map((row) => row.checked)).toEqual([false, false, false]);
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
