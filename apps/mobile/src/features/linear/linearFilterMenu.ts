import {
  DEFAULT_LINEAR_GROUP,
  LINEAR_ASSIGNEE_ANYONE,
  LINEAR_PRIORITY_OPTIONS,
  T3_ACTIVITY_VIEW,
  defaultLinearAssignee,
  linearAssignee,
  type LinearGroupBy,
  type LinearSearch,
  type LinearSearchPatch,
} from "@t3tools/client-runtime/linear/search";
import type {
  LinearCustomView,
  LinearPriority,
  LinearTeamMetadata,
  LinearViewer,
} from "@t3tools/contracts";

import type { MenuProps } from "../../components/ui/Menu.types";

type LinearFilterField = "assignee" | "state" | "priority" | "label" | "cycle" | "view" | "group";

const LINEAR_GROUP_OPTIONS: ReadonlyArray<{ value: LinearGroupBy; label: string }> = [
  { value: "state", label: "State" },
  { value: "milestone", label: "Milestone" },
  { value: "none", label: "None" },
];

const eventId = (field: string, value: string) => JSON.stringify([field, value]);

type Action = MenuProps["actions"][number];

function choice(field: LinearFilterField, value: string, title: string, on: boolean): Action {
  return { id: eventId(field, value), title, state: on ? "on" : "off" };
}

function toggled<Value extends string | number>(
  current: ReadonlyArray<Value> | undefined,
  value: Value,
): Array<Value> | undefined {
  const base = current ?? [];
  const next = base.includes(value) ? base.filter((item) => item !== value) : [...base, value];
  return next.length === 0 ? undefined : next;
}

interface LinearFilterMenuInput {
  readonly search: LinearSearch;
  readonly metadata: LinearTeamMetadata | null;
  readonly views: ReadonlyArray<LinearCustomView>;
  readonly viewer: Pick<LinearViewer, "id"> | null;
}

export interface LinearFilterPill {
  readonly field: LinearFilterField;
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly active: boolean;
  readonly actions: MenuProps["actions"];
}

function summary(labels: ReadonlyArray<string>, name: string): string {
  return labels.length === 0 ? name : labels.length === 1 ? labels[0]! : `${name} ${labels.length}`;
}

/**
 * The filter pills of a milestone's issue list. A saved Linear view carries its own filter, so
 * the controls it would override are left out.
 */
export function buildLinearFilterPills(
  input: LinearFilterMenuInput,
): ReadonlyArray<LinearFilterPill> {
  const { search, metadata, views, viewer } = input;
  const viewLocksFilters = search.view !== undefined && search.view !== T3_ACTIVITY_VIEW;
  const assignee = linearAssignee(search);
  const members = (metadata?.members ?? []).filter((member) => member.id !== viewer?.id);
  const assigneeLabel =
    assignee === "me"
      ? "Me"
      : assignee === LINEAR_ASSIGNEE_ANYONE
        ? "Anyone"
        : (members.find((member) => member.id === assignee)?.name ?? "Someone");
  const states = metadata?.states ?? [];
  const labels = metadata?.labels ?? [];
  const cycles = metadata?.cycles ?? [];
  const viewName =
    search.view === T3_ACTIVITY_VIEW
      ? "Has T3 activity"
      : views.find((view) => view.id === search.view)?.name;
  const filterPills: Array<LinearFilterPill> = viewLocksFilters
    ? []
    : [
        {
          field: "assignee",
          label: assigneeLabel,
          accessibilityLabel: "Filter by assignee",
          active: assignee !== defaultLinearAssignee(search.view),
          actions: [
            choice("assignee", "me", "Me", assignee === "me"),
            choice(
              "assignee",
              LINEAR_ASSIGNEE_ANYONE,
              "Anyone",
              assignee === LINEAR_ASSIGNEE_ANYONE,
            ),
            ...members.map((member) =>
              choice("assignee", member.id, member.name, assignee === member.id),
            ),
          ],
        },
        {
          field: "state",
          label: summary(
            states.filter((state) => search.states?.includes(state.id)).map((state) => state.name),
            "State",
          ),
          accessibilityLabel: "Filter by state",
          active: (search.states?.length ?? 0) > 0,
          actions: [
            choice("state", "", "All states", (search.states?.length ?? 0) === 0),
            ...states.map((state) =>
              choice("state", state.id, state.name, search.states?.includes(state.id) === true),
            ),
          ],
        },
        {
          field: "priority",
          label: summary(
            LINEAR_PRIORITY_OPTIONS.filter((option) => search.priority?.includes(option.value)).map(
              (option) => option.label,
            ),
            "Priority",
          ),
          accessibilityLabel: "Filter by priority",
          active: (search.priority?.length ?? 0) > 0,
          actions: [
            choice("priority", "", "Any priority", (search.priority?.length ?? 0) === 0),
            ...LINEAR_PRIORITY_OPTIONS.map((option) =>
              choice(
                "priority",
                String(option.value),
                option.label,
                search.priority?.includes(option.value) === true,
              ),
            ),
          ],
        },
        {
          field: "label",
          label: summary(
            labels
              .filter((label) => search.labelIds?.includes(label.id))
              .map((label) => label.name),
            "Labels",
          ),
          accessibilityLabel: "Filter by label",
          active: (search.labelIds?.length ?? 0) > 0,
          actions: [
            choice("label", "", "All labels", (search.labelIds?.length ?? 0) === 0),
            ...labels.map((label): Action => ({
              ...choice(
                "label",
                label.id,
                label.name,
                search.labelIds?.includes(label.id) === true,
              ),
              image: "circle.fill",
              imageColor: label.color,
            })),
          ],
        },
        ...(cycles.length === 0
          ? []
          : [
              {
                field: "cycle" as const,
                label:
                  search.cycle === undefined
                    ? "Cycle"
                    : `Cycle ${cycles.find((cycle) => cycle.id === search.cycle)?.number ?? ""}`.trim(),
                accessibilityLabel: "Filter by cycle",
                active: search.cycle !== undefined,
                actions: [
                  choice("cycle", "", "Any cycle", search.cycle === undefined),
                  ...cycles.map((cycle) =>
                    choice(
                      "cycle",
                      cycle.id,
                      `Cycle ${cycle.number}${cycle.isCurrent ? " · current" : cycle.isNext ? " · next" : ""}`,
                      search.cycle === cycle.id,
                    ),
                  ),
                ],
              },
            ]),
      ];
  return [
    {
      field: "view",
      label: viewName ?? "Views",
      accessibilityLabel: "Saved views",
      active: search.view !== undefined,
      actions: [
        choice("view", "", "All issues", search.view === undefined),
        choice("view", T3_ACTIVITY_VIEW, "Has T3 activity", search.view === T3_ACTIVITY_VIEW),
        ...views.map((view): Action => ({
          ...choice("view", view.id, view.name, search.view === view.id),
          ...(view.filterDescription ? { subtitle: view.filterDescription } : {}),
        })),
      ],
    },
    ...filterPills,
    {
      field: "group",
      label: `By ${LINEAR_GROUP_OPTIONS.find((option) => option.value === (search.group ?? DEFAULT_LINEAR_GROUP))?.label.toLowerCase()}`,
      accessibilityLabel: "Group by",
      active: (search.group ?? DEFAULT_LINEAR_GROUP) !== DEFAULT_LINEAR_GROUP,
      actions: LINEAR_GROUP_OPTIONS.map((option) =>
        choice(
          "group",
          option.value,
          option.label,
          (search.group ?? DEFAULT_LINEAR_GROUP) === option.value,
        ),
      ),
    },
  ];
}

/** The search change a tapped menu action stands for; null for anything unrecognised. */
export function linearFilterPatch(search: LinearSearch, event: string): LinearSearchPatch | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    return null;
  }
  const [field, value] = parsed as [string, string];
  switch (field) {
    case "assignee":
      return { assignee: value === defaultLinearAssignee(search.view) ? undefined : value };
    case "state":
      return { states: value === "" ? undefined : toggled(search.states, value) };
    case "priority": {
      if (value === "") return { priority: undefined };
      const priority = Number(value);
      return LINEAR_PRIORITY_OPTIONS.some((option) => option.value === priority)
        ? { priority: toggled(search.priority, priority as LinearPriority) }
        : null;
    }
    case "label":
      return { labelIds: value === "" ? undefined : toggled(search.labelIds, value) };
    case "cycle":
      return { cycle: value === "" ? undefined : value };
    case "view":
      return { view: value === "" ? undefined : value };
    case "group":
      return LINEAR_GROUP_OPTIONS.some((option) => option.value === value)
        ? { group: value as LinearGroupBy }
        : null;
    default:
      return null;
  }
}
