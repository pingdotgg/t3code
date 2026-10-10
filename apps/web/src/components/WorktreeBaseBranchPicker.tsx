import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { usePaginatedBranches } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import {
  matchesRemoteBranch,
  resolveBranchTriggerLabel,
  resolveDefaultWorktreeBaseBranch,
  sanitizeNewRefName,
} from "./BranchToolbar.logic";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Button } from "./ui/button";
import { ComboboxTrigger } from "./ui/combobox";

/** Select a future worktree's base without changing the project's current checkout. */
export function WorktreeBaseBranchPicker({
  environmentId,
  cwd,
  value,
  defaultWorktreeBaseBranch,
  onValueChange,
  startFromOrigin,
  onStartFromOriginChange,
  disabled = false,
  id,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
  value: string;
  defaultWorktreeBaseBranch: string | null | undefined;
  onValueChange: (branch: string) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
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
          input: { cwd, query: value, exact: true, includeMatchingRemoteRefs: true, limit: 10 },
        })
      : null,
  );
  const defaultBranchRefsQuery = useEnvironmentQuery(
    cwd && defaultWorktreeBaseBranch
      ? vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd,
            query: defaultWorktreeBaseBranch,
            exact: true,
            includeMatchingRemoteRefs: true,
            limit: 200,
          },
        })
      : null,
  );
  const defaultBranch = resolveDefaultWorktreeBaseBranch({
    configuredBranch: defaultWorktreeBaseBranch ?? null,
    configuredBranchRefs: [...branches.refs, ...(defaultBranchRefsQuery.data?.refs ?? [])],
    repoDefaultBranch: branches.refs.find((branch) => branch.isDefault) ?? null,
    currentBranch: branches.refs.find((branch) => branch.current)?.name ?? null,
  });
  const defaultBranchIsPending =
    defaultWorktreeBaseBranch === undefined ||
    (branches.isPending && branches.data === null) ||
    (defaultWorktreeBaseBranch !== null &&
      defaultBranchRefsQuery.isPending &&
      defaultBranchRefsQuery.data === null);

  useEffect(() => {
    if (value || !cwd || defaultBranchIsPending) return;
    if (defaultBranch !== null) onValueChange(defaultBranch);
  }, [cwd, defaultBranch, defaultBranchIsPending, onValueChange, value]);

  const selectedRef =
    branches.refs.find((branch) => branch.name === value) ??
    selectedRefQuery.data?.refs.find((branch) => branch.name === value) ??
    defaultBranchRefsQuery.data?.refs.find((branch) => matchesRemoteBranch(branch, value));
  const selectedRefIsRemoteAlias = selectedRef?.isRemote === true && selectedRef.name !== value;
  const label = resolveBranchTriggerLabel({
    activeWorktreePath: null,
    effectiveEnvMode: "worktree",
    resolvedActiveBranch: value || null,
    resolvedActiveBranchIsRemote: selectedRef
      ? selectedRefIsRemoteAlias
        ? false
        : selectedRef.isRemote === true
      : null,
    startFromOrigin,
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
      ? "Loading refs..."
      : branches.isFetchingNextPage
        ? "Loading more refs..."
        : hasNextPage
          ? `Showing ${branches.refs.length} of ${branches.data?.totalCount} refs`
          : null);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  return (
    <BranchPicker
      items={items}
      filteredItems={items}
      value={value || null}
      query={query}
      resultsQuery={deferredQuery}
      onQueryChange={setQuery}
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      onSelectItem={(name) => {
        onValueChange(name);
        handleOpenChange(false);
      }}
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
        className="w-full justify-between "
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <MiddleTruncate value={label} className="flex-1 text-left" />
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxTrigger>
    </BranchPicker>
  );
}
