import type {
  LinearCustomView,
  LinearPriority,
  LinearTeamMetadata,
  LinearViewer,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleDotIcon,
  LayersIcon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
  UserRoundIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode, type Ref } from "react";

import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd } from "../ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { LinearAvatar, LinearPriorityIcon, LinearStateIcon } from "./linearIcons";
import {
  LINEAR_ASSIGNEE_ANYONE,
  T3_ACTIVITY_VIEW,
  DEFAULT_LINEAR_GROUP,
  defaultLinearAssignee,
  linearAssignee,
  type LinearGroupBy,
  type LinearSearch,
  type LinearSearchPatch,
} from "@t3tools/client-runtime/linear/search";

const SEARCH_COMMIT_DELAY_MS = 250;
const PRIORITY_OPTIONS: ReadonlyArray<{ value: LinearPriority; label: string }> = [
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
  { value: 0, label: "No priority" },
];

function FilterPill({
  icon,
  label,
  value,
  active,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  value?: string | undefined;
  active: boolean;
  disabled?: boolean | undefined;
}) {
  return (
    <MenuTrigger
      disabled={disabled}
      render={<Button variant={active ? "secondary" : "outline"} size="compact" />}
      className="max-w-48"
    >
      {icon}
      <span>{label}</span>
      {value ? <span className="truncate font-medium text-foreground">{value}</span> : null}
      <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
    </MenuTrigger>
  );
}

interface FilterOption<Value> {
  readonly value: Value;
  readonly label: string;
  readonly icon?: ReactNode;
}

function MultiFilter<Value extends string | number>({
  icon,
  label,
  options,
  selected,
  disabled,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  options: ReadonlyArray<FilterOption<Value>>;
  selected: ReadonlyArray<Value> | undefined;
  disabled?: boolean | undefined;
  onChange: (next: Array<Value> | undefined) => void;
}) {
  const current = selected ?? [];
  const summary =
    current.length === 0
      ? undefined
      : current.length === 1
        ? options.find((option) => option.value === current[0])?.label
        : `${current.length}`;
  return (
    <Menu>
      <FilterPill
        icon={icon}
        label={label}
        value={summary}
        active={current.length > 0}
        disabled={disabled === true || options.length === 0}
      />
      <MenuPopup align="start" side="bottom" className="max-h-80">
        {options.map((option) => (
          <MenuCheckboxItem
            key={option.value}
            checked={current.includes(option.value)}
            closeOnClick={false}
            onCheckedChange={(checked) => {
              const next = checked
                ? [...current, option.value]
                : current.filter((value) => value !== option.value);
              onChange(next.length === 0 ? undefined : next);
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              {option.icon}
              <span className="truncate">{option.label}</span>
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function SingleFilter({
  icon,
  label,
  options,
  value,
  fallbackLabel,
  active,
  disabled,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  options: ReadonlyArray<FilterOption<string>>;
  value: string;
  fallbackLabel?: string | undefined;
  active: boolean;
  disabled?: boolean | undefined;
  onChange: (next: string) => void;
}) {
  const current = options.find((option) => option.value === value)?.label ?? fallbackLabel;
  return (
    <Menu>
      <FilterPill icon={icon} label={label} value={current} active={active} disabled={disabled} />
      <MenuPopup align="start" side="bottom" className="max-h-80">
        <MenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              <span className="flex min-w-0 items-center gap-2">
                {option.icon}
                <span className="truncate">{option.label}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function SavedViewsMenu({
  views,
  value,
  onChange,
}: {
  views: ReadonlyArray<LinearCustomView>;
  value: string | undefined;
  onChange: (view: string | undefined) => void;
}) {
  const current =
    value === T3_ACTIVITY_VIEW ? "Has T3 activity" : views.find((view) => view.id === value)?.name;
  return (
    <Menu>
      <FilterPill
        icon={<LayersIcon aria-hidden />}
        label="Saved views"
        value={current}
        active={value !== undefined}
      />
      <MenuPopup align="end" side="bottom" className="max-h-80 min-w-56">
        <MenuRadioGroup
          value={value ?? ""}
          onValueChange={(next) => onChange(next === "" ? undefined : next)}
        >
          <MenuRadioItem value="">All issues</MenuRadioItem>
          <MenuSeparator />
          <MenuGroupLabel>T3</MenuGroupLabel>
          <MenuRadioItem value={T3_ACTIVITY_VIEW}>Has T3 activity</MenuRadioItem>
          {views.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuGroupLabel>Linear views</MenuGroupLabel>
              {views.map((view) => (
                <MenuRadioItem key={view.id} value={view.id}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{view.name}</span>
                    {view.filterDescription ? (
                      <span className="truncate text-2xs text-muted-foreground">
                        {view.filterDescription}
                      </span>
                    ) : null}
                  </span>
                </MenuRadioItem>
              ))}
            </>
          ) : null}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function IssueSearchInput({
  value,
  inputRef,
  onCommit,
}: {
  value: string;
  inputRef: Ref<HTMLInputElement>;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const commit = (next: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    onCommit(next);
  };
  return (
    <InputGroup className="min-w-40 max-w-80 flex-1 **:[input]:h-7 sm:**:[input]:h-7">
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="search"
        value={draft ?? value}
        placeholder="Search issues"
        aria-label="Search issues"
        onFocus={() => setDraft(value)}
        onBlur={() => {
          if (timer.current !== null) commit(draft ?? value);
          setDraft(null);
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => commit(next), SEARCH_COMMIT_DELAY_MS);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            commit(event.currentTarget.value);
          }
          if (event.key === "Escape") event.currentTarget.blur();
        }}
      />
      {value === "" && draft === null ? (
        <InputGroupAddon align="inline-end">
          <Kbd>/</Kbd>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

export function LinearFilters({
  search,
  metadata,
  views,
  viewer,
  searchInputRef,
  onSearchChange,
}: {
  search: LinearSearch;
  metadata: LinearTeamMetadata | null;
  views: ReadonlyArray<LinearCustomView>;
  viewer: LinearViewer | null;
  searchInputRef: Ref<HTMLInputElement>;
  onSearchChange: (patch: LinearSearchPatch) => void;
}) {
  // A custom view carries its own filter, so the controls it would override stand aside.
  const viewLocksFilters = search.view !== undefined && search.view !== T3_ACTIVITY_VIEW;
  const assignee = linearAssignee(search);
  const defaultAssignee = defaultLinearAssignee(search.view);
  const assigneeOptions: ReadonlyArray<FilterOption<string>> = [
    {
      value: "me",
      label: "Me",
      icon: <LinearAvatar user={viewer} className="size-3.5" />,
    },
    { value: LINEAR_ASSIGNEE_ANYONE, label: "Anyone" },
    ...(metadata?.members ?? [])
      .filter((member) => member.id !== viewer?.id)
      .map((member) => ({
        value: member.id,
        label: member.name,
        icon: <LinearAvatar user={member} className="size-3.5" />,
      })),
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <IssueSearchInput
          value={search.q ?? ""}
          inputRef={searchInputRef}
          onCommit={(q) => onSearchChange({ q: q.trim() === "" ? undefined : q.trim() })}
        />
        <div className="ml-auto flex items-center gap-2">
          <ToggleGroup
            aria-label="Group by"
            value={[search.group ?? DEFAULT_LINEAR_GROUP]}
            onValueChange={(next) => {
              const group = next[0] as LinearGroupBy | undefined;
              if (group !== undefined) onSearchChange({ group });
            }}
          >
            <Toggle value="state" size="xs">
              State
            </Toggle>
            <Toggle value="milestone" size="xs">
              Milestone
            </Toggle>
            <Toggle value="none" size="xs">
              None
            </Toggle>
          </ToggleGroup>
          <SavedViewsMenu
            views={views}
            value={search.view}
            onChange={(view) => onSearchChange({ view })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <SingleFilter
          icon={<UserRoundIcon aria-hidden />}
          label="Assignee"
          options={assigneeOptions}
          value={assignee}
          fallbackLabel="Someone"
          active={assignee !== defaultAssignee}
          disabled={viewLocksFilters}
          onChange={(next) =>
            onSearchChange({ assignee: next === defaultAssignee ? undefined : next })
          }
        />
        <MultiFilter
          icon={<CircleDotIcon aria-hidden />}
          label="State"
          options={(metadata?.states ?? []).map((state) => ({
            value: state.id,
            label: state.name,
            icon: <LinearStateIcon type={state.type} color={state.color} />,
          }))}
          selected={search.states}
          disabled={viewLocksFilters}
          onChange={(states) => onSearchChange({ states })}
        />
        <MultiFilter
          icon={<LayersIcon aria-hidden />}
          label="Priority"
          options={PRIORITY_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
            icon: <LinearPriorityIcon priority={option.value} />,
          }))}
          selected={search.priority}
          disabled={viewLocksFilters}
          onChange={(priority) => onSearchChange({ priority })}
        />
        <MultiFilter
          icon={<TagIcon aria-hidden />}
          label="Labels"
          options={(metadata?.labels ?? []).map((label) => ({
            value: label.id,
            label: label.name,
            icon: (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: label.color }}
              />
            ),
          }))}
          selected={search.labelIds}
          disabled={viewLocksFilters}
          onChange={(labelIds) => onSearchChange({ labelIds })}
        />
        <SingleFilter
          icon={<RefreshCwIcon aria-hidden />}
          label="Cycle"
          options={[
            { value: "", label: "Any cycle" },
            ...(metadata?.cycles ?? []).map((cycle) => ({
              value: cycle.id,
              label: `Cycle ${cycle.number}${cycle.isCurrent ? " · current" : cycle.isNext ? " · next" : ""}`,
            })),
          ]}
          value={search.cycle ?? ""}
          active={search.cycle !== undefined}
          disabled={viewLocksFilters || (metadata?.cycles.length ?? 0) === 0}
          onChange={(cycle) => onSearchChange({ cycle: cycle === "" ? undefined : cycle })}
        />
        {viewLocksFilters ? (
          <span className="text-xs text-muted-foreground">Filters come from the saved view</span>
        ) : null}
      </div>
    </div>
  );
}
