import type { IssueInvolvement, IssueListState, IssueTrackerSummary } from "@t3tools/contracts";
import { ScrollView } from "react-native";
import { ControlPill } from "../../components/ControlPill";
import type { IssueListFilters as Controls } from "../../persistence/mobile-preferences";
import { ListFilterMenu } from "../workspace/ListFilterMenu";

const STATES = { open: "Open", closed: "Closed", all: "All states" } as const;
const INVOLVEMENT = {
  all: "Everyone",
  assigned: "Assigned to me",
  authored: "Opened by me",
  mentioned: "Mentioning me",
} as const;
const id = (field: string, value: string) => JSON.stringify([field, value]);
function choices(field: string, options: Readonly<Record<string, string>>, selected: string) {
  return Object.entries(options).map(([value, title]) => ({
    id: id(field, value),
    title,
    state: value === selected ? ("on" as const) : ("off" as const),
  }));
}

export function IssueListFilters(props: {
  readonly environments: readonly { id: string; label: string }[];
  readonly value: Controls;
  readonly onChange: (value: Controls) => void;
  readonly involvements: ReadonlySet<IssueInvolvement> | null;
  readonly trackers: readonly IssueTrackerSummary[];
  readonly projects: readonly { id: string; title: string; environmentId: string }[];
  readonly onCreate: (() => void) | null;
}) {
  const { value } = props;
  const select = (event: string) => {
    let selection: unknown;
    try {
      selection = JSON.parse(event);
    } catch {
      return;
    }
    if (
      !Array.isArray(selection) ||
      selection.length !== 2 ||
      typeof selection[0] !== "string" ||
      typeof selection[1] !== "string"
    )
      return;
    const [field, next] = selection;
    const { projectId: _projectId, projectEnvironmentId: _projectEnvironmentId, ...rest } = value;
    switch (field) {
      case "environment":
        if (next === "") props.onChange({ ...rest, environmentId: null });
        else if (props.environments.some((environment) => environment.id === next))
          props.onChange({ ...rest, environmentId: next });
        break;
      case "reset":
        props.onChange({ environmentId: value.environmentId, state: "open", involvement: "all" });
        break;
      case "state":
        if (next in STATES) props.onChange({ ...value, state: next as IssueListState });
        break;
      case "involvement":
        if (next in INVOLVEMENT)
          props.onChange({ ...value, involvement: next as IssueInvolvement });
        break;
      case "tracker": {
        const { host: _host, ...withoutHost } = value;
        props.onChange(next ? { ...value, host: next } : withoutHost);
        break;
      }
      case "project": {
        const project = props.projects.find(
          (project) => JSON.stringify([project.environmentId, project.id]) === next,
        );
        props.onChange(
          project
            ? { ...value, projectId: project.id, projectEnvironmentId: project.environmentId }
            : rest,
        );
        break;
      }
    }
  };
  const count =
    Number(value.state !== "open") +
    Number(value.involvement !== "all") +
    Number(Boolean(value.host)) +
    Number(Boolean(value.projectId));
  const involvements = Object.fromEntries(
    Object.entries(INVOLVEMENT).filter(
      ([involvement]) =>
        props.involvements === null || props.involvements.has(involvement as IssueInvolvement),
    ),
  );
  const hosts = [...new Set(props.trackers.map((tracker) => tracker.host))];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      {props.onCreate ? (
        <ControlPill
          icon="plus"
          label="New issue"
          accessibilityLabel="New issue"
          variant="primary"
          onPress={props.onCreate}
        />
      ) : null}
      <ListFilterMenu
        label={count ? String(count) : "Filters"}
        icon
        active={count > 0}
        accessibilityLabel={count ? `Filters, ${count} active` : "More filters"}
        actions={[
          {
            id: "projects",
            title:
              props.projects.find(
                (project) =>
                  project.id === value.projectId &&
                  project.environmentId === value.projectEnvironmentId,
              )?.title ?? "Project",
            subactions: choices(
              "project",
              Object.fromEntries([
                ["", "All projects"],
                ...props.projects.map((project) => [
                  JSON.stringify([project.environmentId, project.id]),
                  project.title,
                ]),
              ]),
              value.projectId ? JSON.stringify([value.projectEnvironmentId, value.projectId]) : "",
            ),
          },
          { id: id("reset", ""), title: "Reset filters", attributes: { disabled: count === 0 } },
        ]}
        onSelect={select}
      />
      {props.environments.length > 1 ? (
        <ListFilterMenu
          label={
            props.environments.find((environment) => environment.id === value.environmentId)
              ?.label ?? "All environments"
          }
          accessibilityLabel="Choose issue environment"
          actions={choices(
            "environment",
            Object.fromEntries([
              ["", "All environments"],
              ...props.environments.map((environment) => [environment.id, environment.label]),
            ]),
            value.environmentId ?? "",
          )}
          onSelect={select}
        />
      ) : null}
      <ListFilterMenu
        label={STATES[value.state]}
        active={value.state !== "open"}
        accessibilityLabel="Filter by state"
        actions={choices("state", STATES, value.state)}
        onSelect={select}
      />
      <ListFilterMenu
        label={INVOLVEMENT[value.involvement]}
        active={value.involvement !== "all"}
        accessibilityLabel="Filter by involvement"
        actions={choices("involvement", involvements, value.involvement)}
        onSelect={select}
      />
      {hosts.length > 1 || value.host ? (
        <ListFilterMenu
          label={value.host ?? "All trackers"}
          active={Boolean(value.host)}
          accessibilityLabel="Filter by tracker"
          actions={choices(
            "tracker",
            Object.fromEntries([["", "All trackers"], ...hosts.map((host) => [host, host])]),
            value.host ?? "",
          )}
          onSelect={select}
        />
      ) : null}
    </ScrollView>
  );
}
