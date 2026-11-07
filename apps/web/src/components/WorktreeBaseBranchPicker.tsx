import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useState } from "react";

import { usePaginatedBranches } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { resolveBranchTriggerLabel, sanitizeNewRefName } from "./BranchToolbar.logic";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Button } from "./ui/button";
import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";

// Refs cannot contain NUL, so these item values never collide with a ref name.
const DEFAULT_ITEM_VALUE = "\u0000default";
const CUSTOM_ITEM_PREFIX = "\u0000custom:";

export function WorktreeBaseBranchPicker({
  environmentId,
  cwd,
  value,
  onValueChange,
  startFromOrigin,
  onStartFromOriginChange,
  defaultOption,
  allowCustomRef = false,
  emptyLabel,
  disabled = false,
  id,
  "aria-label": ariaLabel,
}: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  value: string;
  onValueChange: (branch: string) => void;
  startFromOrigin: boolean;
  /** Omit when the start-from-remote choice is edited elsewhere. */
  onStartFromOriginChange?: (checked: boolean) => void;
  /** Lists an item that selects the empty value; its badge names the default ref. */
  defaultOption?: { label: string };
  /** Lets a typed name be used as is, for a tag, a commit, or a ref outside the list. */
  allowCustomRef?: boolean;
  /** Shows the ref name as is, and this label while the value is empty. */
  emptyLabel?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const branches = usePaginatedBranches({
    environmentId,
    cwd,
    query: sanitizeNewRefName(trimmedQuery),
  });
  const selectedRefQuery = useEnvironmentQuery(
    environmentId && cwd && value
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd, query: value, limit: 10 },
        })
      : null,
  );
  const selectedRef =
    branches.refs.find((branch) => branch.name === value) ??
    selectedRefQuery.data?.refs.find((branch) => branch.name === value);
  const label =
    emptyLabel !== undefined
      ? value || emptyLabel
      : resolveBranchTriggerLabel({
          activeWorktreePath: null,
          effectiveEnvMode: "worktree",
          resolvedActiveBranch: value || null,
          resolvedActiveBranchIsRemote: selectedRef ? selectedRef.isRemote === true : null,
          startFromOrigin,
        });
  const branchByName = new Map(branches.refs.map((branch) => [branch.name, branch]));
  const defaultRefName = branches.refs.find((branch) => branch.isDefault)?.name;
  const customRefItemValue =
    allowCustomRef && trimmedQuery !== "" && !branchByName.has(trimmedQuery)
      ? `${CUSTOM_ITEM_PREFIX}${trimmedQuery}`
      : null;
  const items = [
    ...(defaultOption && trimmedQuery === "" ? [DEFAULT_ITEM_VALUE] : []),
    ...branchByName.keys(),
    ...(customRefItemValue ? [customRefItemValue] : []),
  ];
  const hasNextPage = branches.data?.nextCursor != null;
  const statusText = !cwd
    ? "Choose a project to list its branches."
    : (branches.error ??
      (branches.isPending && branches.data === null
        ? "Loading refs..."
        : branches.isFetchingNextPage
          ? "Loading more refs..."
          : hasNextPage
            ? `Showing ${branches.refs.length} of ${branches.data?.totalCount} refs`
            : null));
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const selectItem = (itemValue: string) => {
    if (itemValue === DEFAULT_ITEM_VALUE) onValueChange("");
    else if (itemValue.startsWith(CUSTOM_ITEM_PREFIX))
      onValueChange(itemValue.slice(CUSTOM_ITEM_PREFIX.length));
    else onValueChange(itemValue);
    handleOpenChange(false);
  };
  return (
    <BranchPicker
      items={items}
      filteredItems={items}
      value={value || (defaultOption ? DEFAULT_ITEM_VALUE : null)}
      query={query}
      onQueryChange={setQuery}
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      onSelectItem={selectItem}
      hasNextPage={hasNextPage}
      isFetchingNextPage={branches.isFetchingNextPage}
      onLoadNext={branches.loadNext}
      statusText={statusText}
      originControl={
        onStartFromOriginChange
          ? { checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }
          : undefined
      }
      popupProps={{ align: "start", side: "bottom", className: "flex w-80 flex-col" }}
      renderItem={(itemValue, index) => {
        if (defaultOption && itemValue === DEFAULT_ITEM_VALUE) {
          return (
            <ComboboxItem
              hideIndicator
              key={itemValue}
              index={index}
              value={itemValue}
              onClick={() => selectItem(itemValue)}
            >
              <div className="flex w-full min-w-0 items-center justify-between gap-2">
                <span className="truncate">{defaultOption.label}</span>
                {defaultRefName && (
                  <span className="shrink-0 text-3xs text-muted-foreground/45">
                    {defaultRefName}
                  </span>
                )}
              </div>
            </ComboboxItem>
          );
        }
        if (customRefItemValue && itemValue === customRefItemValue) {
          return (
            <ComboboxItem
              hideIndicator
              key={itemValue}
              index={index}
              value={itemValue}
              onClick={() => selectItem(itemValue)}
            >
              <span className="truncate">Use &quot;{trimmedQuery}&quot;</span>
            </ComboboxItem>
          );
        }
        const branch = branchByName.get(itemValue);
        return branch ? (
          <BranchPickerRefItem
            branch={branch}
            projectCwd={cwd}
            index={index}
            onClick={() => selectItem(branch.name)}
          />
        ) : null;
      }}
    >
      <ComboboxTrigger
        id={id}
        aria-label={ariaLabel}
        disabled={disabled || (!cwd && !allowCustomRef)}
        render={<Button variant="outline" size="sm" />}
        className="w-full justify-between "
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <MiddleTruncate value={label} className="flex-1 text-left" />
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxTrigger>
    </BranchPicker>
  );
}
