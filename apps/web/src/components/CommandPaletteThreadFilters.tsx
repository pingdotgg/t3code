import { ListFilterIcon } from "lucide-react";
import { useMemo, type RefObject } from "react";

import {
  clearThreadSearchQualifiers,
  parseThreadSearchQuery,
  toggleThreadSearchQualifier,
  type ParsedThreadSearchQuery,
  type ThreadSearchQualifierToggleKey,
} from "@t3tools/client-runtime/state/threadSearchQuery";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";

interface FilterOption {
  readonly label: string;
  readonly value: string;
}

const STATUS_OPTIONS: ReadonlyArray<FilterOption> = [
  { label: "Working", value: "working" },
  { label: "Needs approval", value: "approval" },
  { label: "Needs input", value: "input" },
  { label: "Failed", value: "failed" },
  { label: "Ready", value: "ready" },
];

const UPDATED_OPTIONS: ReadonlyArray<FilterOption> = [
  { label: "Today", value: "today" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
];

function hasSelectedValue(
  parsedQuery: ParsedThreadSearchQuery,
  key: Exclude<ThreadSearchQualifierToggleKey, "archived">,
  value: string,
): boolean {
  return parsedQuery.filters[key].some(
    (clause) =>
      !clause.negated &&
      clause.values.some((candidate) => candidate.toLowerCase() === value.toLowerCase()),
  );
}

function countRecognizedQualifiers(parsedQuery: ParsedThreadSearchQuery): number {
  const keys = ["project", "env", "branch", "provider", "status", "since", "before"] as const;
  return (
    keys.reduce((count, key) => count + parsedQuery.filters[key].length, 0) +
    (parsedQuery.filters.archived ? 1 : 0)
  );
}

export function CommandPaletteThreadFilters({
  query,
  projects,
  providers,
  environments,
  inputRef,
  onQueryChange,
}: {
  readonly query: string;
  readonly projects: ReadonlyArray<FilterOption>;
  readonly providers: ReadonlyArray<FilterOption>;
  readonly environments: ReadonlyArray<FilterOption>;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onQueryChange: (query: string) => void;
}) {
  const parsedQuery = useMemo(() => parseThreadSearchQuery(query, { now: new Date() }), [query]);
  const filterCount = countRecognizedQualifiers(parsedQuery);
  const selected = (key: Exclude<ThreadSearchQualifierToggleKey, "archived">, value: string) =>
    hasSelectedValue(parsedQuery, key, value);
  const toggle = (key: ThreadSearchQualifierToggleKey, value: string, multi: boolean) => {
    onQueryChange(toggleThreadSearchQualifier(query, key, value, { multi }));
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label="Filter threads"
            className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
            size="icon-xs"
            variant="ghost-muted"
          />
        }
      >
        <ListFilterIcon aria-hidden />
        {filterCount > 0 ? (
          <Badge aria-hidden className="absolute -end-1 -top-1" size="sm">
            {filterCount}
          </Badge>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" finalFocus={inputRef}>
        <MenuGroup>
          <MenuGroupLabel>Status</MenuGroupLabel>
          {STATUS_OPTIONS.map((option) => (
            <MenuCheckboxItem
              closeOnClick
              key={option.value}
              checked={selected("status", option.value)}
              onCheckedChange={() => toggle("status", option.value, true)}
            >
              {option.label}
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger>Project</MenuSubTrigger>
          <MenuSubPopup>
            <MenuGroupLabel>Project</MenuGroupLabel>
            {projects.length === 0 ? (
              <MenuItem disabled>No projects</MenuItem>
            ) : (
              projects.map((option) => (
                <MenuCheckboxItem
                  closeOnClick
                  key={option.value}
                  checked={selected("project", option.value)}
                  onCheckedChange={() => toggle("project", option.value, true)}
                >
                  {option.label}
                </MenuCheckboxItem>
              ))
            )}
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>Provider</MenuSubTrigger>
          <MenuSubPopup>
            <MenuGroupLabel>Provider</MenuGroupLabel>
            {providers.length === 0 ? (
              <MenuItem disabled>No providers</MenuItem>
            ) : (
              providers.map((option) => (
                <MenuCheckboxItem
                  closeOnClick
                  key={option.value}
                  checked={selected("provider", option.value)}
                  onCheckedChange={() => toggle("provider", option.value, true)}
                >
                  {option.label}
                </MenuCheckboxItem>
              ))
            )}
          </MenuSubPopup>
        </MenuSub>
        {environments.length > 0 ? (
          <MenuSub>
            <MenuSubTrigger>Environment</MenuSubTrigger>
            <MenuSubPopup>
              <MenuGroupLabel>Environment</MenuGroupLabel>
              {environments.map((option) => (
                <MenuCheckboxItem
                  closeOnClick
                  key={option.value}
                  checked={selected("env", option.value)}
                  onCheckedChange={() => toggle("env", option.value, true)}
                >
                  {option.label}
                </MenuCheckboxItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Updated</MenuGroupLabel>
          {UPDATED_OPTIONS.map((option) => (
            <MenuCheckboxItem
              closeOnClick
              key={option.value}
              checked={selected("since", option.value)}
              onCheckedChange={() => toggle("since", option.value, false)}
            >
              {option.label}
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem
          closeOnClick
          checked={parsedQuery.filters.archived}
          onCheckedChange={() => toggle("archived", "archived", false)}
        >
          Archived
        </MenuCheckboxItem>
        {filterCount > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                onQueryChange(clearThreadSearchQualifiers(query));
              }}
            >
              Clear filters
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
