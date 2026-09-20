import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

import { usePaginatedBranches } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { useVcsTerminology, vcsEnvironment } from "../state/vcs";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { resolveBranchTriggerLabel, sanitizeNewRefName } from "./BranchToolbar.logic";
import { Button } from "./ui/button";
import { ComboboxTrigger } from "./ui/combobox";

/** Select a future worktree's base without changing the project's current checkout. */
export function WorktreeBaseBranchPicker({
  environmentId,
  cwd,
  value,
  onValueChange,
  startFromOrigin,
  onStartFromOriginChange,
  disabled = false,
  id,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
  value: string;
  onValueChange: (branch: string) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const terminology = useVcsTerminology(environmentId, cwd);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const branches = usePaginatedBranches({
    environmentId,
    cwd,
    query: sanitizeNewRefName(deferredQuery),
  });
  const selectedRefQuery = useEnvironmentQuery(
    cwd && value
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd, query: value, limit: 10 },
        })
      : null,
  );
  const selectedRef =
    branches.refs.find((branch) => branch.name === value) ??
    selectedRefQuery.data?.refs.find((branch) => branch.name === value);
  const label = resolveBranchTriggerLabel({
    activeWorktreePath: null,
    effectiveEnvMode: "worktree",
    resolvedActiveBranch: value || null,
    resolvedActiveBranchIsRemote: selectedRef ? selectedRef.isRemote === true : null,
    startFromOrigin,
    terminology,
  });
  const branchByName = useMemo(
    () => new Map(branches.refs.map((branch) => [branch.name, branch])),
    [branches.refs],
  );
  const items = [...branchByName.keys()];
  const hasNextPage = branches.data?.nextCursor != null;
  const statusText =
    branches.error ??
    (branches.isPending && branches.data === null
      ? `Loading ${terminology.refNounPlural}...`
      : branches.isFetchingNextPage
        ? `Loading more ${terminology.refNounPlural}...`
        : hasNextPage
          ? `Showing ${branches.refs.length} of ${branches.data?.totalCount} ${terminology.refNounPlural}`
          : null);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  return (
    <BranchPicker
      terminology={terminology}
      items={items}
      filteredItems={items}
      value={value || null}
      query={query}
      resultsQuery={deferredQuery}
      onQueryChange={setQuery}
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      hasNextPage={hasNextPage}
      isFetchingNextPage={branches.isFetchingNextPage}
      onLoadNext={branches.loadNext}
      statusText={statusText}
      originControl={{ checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }}
      popupProps={{ align: "start", side: "bottom", className: "flex w-80 flex-col" }}
      renderItem={(name, index) => {
        const branch = branchByName.get(name);
        return branch ? (
          <BranchPickerRefItem
            terminology={terminology}
            branch={branch}
            projectCwd={cwd}
            index={index}
            onClick={() => {
              onValueChange(branch.name);
              handleOpenChange(false);
            }}
          />
        ) : null;
      }}
    >
      <ComboboxTrigger
        id={id}
        disabled={disabled || !cwd}
        render={<Button variant="outline" size="sm" />}
        className="w-full justify-between font-normal"
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxTrigger>
    </BranchPicker>
  );
}
