import { SettingsIcon } from "lucide-react";
import {
  useMemo,
  useReducer,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { useEnvironmentMachines, usePrimaryEnvironmentId } from "~/state/environments";
import {
  projectGroupsSpanEnvironments,
  type SidebarProjectSnapshot,
} from "~/sidebarProjectGrouping";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import { ProjectFavicon } from "./ProjectFavicon";
import { filterProjectPickerItems, reduceProjectPickerMenuState } from "./ProjectPicker.logic";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  useComboboxFilter,
} from "./ui/combobox";

export interface ProjectPickerItem {
  readonly value: string;
  readonly label: string;
  /** Null for rows that are not a project, such as "All projects". */
  readonly project: SidebarProjectSnapshot | null;
  /** Leading icon for rows without a project. */
  readonly icon?: ReactNode;
  readonly hideWhileSearching?: boolean;
}

/**
 * Searchable project list behind the sidebar's project filter and the draft
 * screen's project selector. The caller renders the `ComboboxTrigger` as
 * `trigger`, since each surface has its own button.
 */
export function ProjectPicker(props: {
  readonly items: readonly ProjectPickerItem[];
  readonly selectedValue: string | null;
  readonly onSelect: (item: ProjectPickerItem) => void;
  readonly trigger: ReactNode;
  readonly align?: "start" | "center" | "end";
  readonly anchor?: React.RefObject<Element | null>;
  /** Adds a settings button and the context-menu gesture to project rows. */
  readonly onProjectSettings?: (project: SidebarProjectSnapshot) => void;
}) {
  const { items, onProjectSettings } = props;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentMachineById = useEnvironmentMachines();
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () =>
      projectGroupsSpanEnvironments(
        items.flatMap((item) => (item.project === null ? [] : [item.project])),
      ),
    [items],
  );
  const [menuState, dispatchMenu] = useReducer(reduceProjectPickerMenuState, {
    open: false,
    query: "",
  });
  const filter = useComboboxFilter();
  // Filtering derives from the same React state that controls the input, so
  // the visible query and the visible list can never desync.
  const filteredItems = useMemo(
    () =>
      filterProjectPickerItems({
        items,
        query: menuState.query,
        matches: (item, query) => filter.contains(item, query, (candidate) => candidate.label),
      }),
    [filter, items, menuState.query],
  );
  const selectedItem = items.find((item) => item.value === props.selectedValue) ?? null;
  // Safari can send a click after Ctrl+click opens settings. Ignore that one
  // selection, then clear the guard when the picker opens again.
  const suppressNextChangeRef = useRef(false);
  const highlightedValueRef = useRef<string | null>(null);
  const openSettings = (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
    project: SidebarProjectSnapshot,
  ) => {
    if (!onProjectSettings) return;
    event.preventDefault();
    event.stopPropagation();
    suppressNextChangeRef.current = true;
    dispatchMenu({ type: "project-settings-opened" });
    onProjectSettings(project);
  };

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={menuState.open}
      onOpenChange={(open) => {
        if (open) suppressNextChangeRef.current = false;
        dispatchMenu({ type: "open-changed", open });
      }}
      onItemHighlighted={(item) => {
        highlightedValueRef.current = item?.value ?? null;
      }}
      value={selectedItem}
      onValueChange={(item) => {
        if (suppressNextChangeRef.current) {
          suppressNextChangeRef.current = false;
          return;
        }
        if (!item) return;
        dispatchMenu({ type: "open-changed", open: false });
        props.onSelect(item);
      }}
    >
      {props.trigger}
      <ComboboxPopup
        align={props.align ?? "start"}
        anchor={props.anchor}
        // At least as wide as its anchor, growing to fit project names up to
        // a cap, past which the rows truncate.
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={menuState.query}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
            ) {
              return;
            }
            // Combobox items use virtual focus: keyboard events stay on this
            // input, not on the highlighted option.
            const project = items.find(
              (item) => item.value === highlightedValueRef.current,
            )?.project;
            if (project) openSettings(event, project);
          }}
          onChange={(event) => dispatchMenu({ type: "query-changed", query: event.target.value })}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: ProjectPickerItem) => {
            const project = item.project;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                onContextMenu={(event) => {
                  if (project) openSettings(event, project);
                }}
              >
                {project ? (
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                ) : (
                  item.icon
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                {project && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={project}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
                {project && onProjectSettings ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    tabIndex={-1}
                    aria-hidden="true"
                    title={`Project settings for ${project.displayName}`}
                    className="ml-auto"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => openSettings(event, project)}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
