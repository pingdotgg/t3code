import { type EnvironmentId, GIT_LIST_BRANCHES_MAX_LIMIT } from "@t3tools/contracts";
import { normalizeWorktreeBranchName, sanitizeWorktreeBranchNameInput } from "@t3tools/shared/git";
import { useDeferredValue, useEffect, useRef } from "react";

import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";

/**
 * What the send path knows about the typed name. `null` means no name is in
 * play (empty input, or the input isn't mounted to validate one), so the send
 * path must fall back to the generated branch name.
 */
export interface WorktreeBranchNameStatus {
  /** The normalized name — the branch that would actually be created. */
  name: string;
  state: "checking" | "available" | "conflict";
}

interface BranchToolbarWorktreeNameInputProps {
  environmentId: EnvironmentId;
  /** Project root the refs are checked against (the worktree doesn't exist yet). */
  cwd: string;
  value: string;
  onValueChange: (value: string) => void;
  onStatusChange?: (status: WorktreeBranchNameStatus | null) => void;
}

/**
 * Low-profile input naming the branch the next worktree is created with.
 * Left empty, the branch name is generated from the first message instead.
 * Marks itself invalid when a local branch with that name already exists.
 */
export function BranchToolbarWorktreeNameInput({
  environmentId,
  cwd,
  value,
  onValueChange,
  onStatusChange,
}: BranchToolbarWorktreeNameInputProps) {
  const normalizedValue = normalizeWorktreeBranchName(value);
  const deferredNormalizedValue = useDeferredValue(normalizedValue);
  const conflictRefsQuery = useEnvironmentQuery(
    deferredNormalizedValue === null
      ? null
      : vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd,
            query: deferredNormalizedValue,
            // The server matches the query as a substring and pages the
            // result, so an exact match can fall off a short page. Locals
            // only (remotes can't collide) at the max page size.
            refKind: "local",
            limit: GIT_LIST_BRANCHES_MAX_LIMIT,
          },
        }),
  );
  // Only a settled lookup for the value currently typed can clear a name for
  // send; while the deferred value lags or the query is in flight the answer
  // belongs to a different name. A failed lookup counts as settled — the
  // server rejects a duplicate branch anyway.
  const checked =
    deferredNormalizedValue === normalizedValue &&
    (conflictRefsQuery.data !== null || conflictRefsQuery.error !== null);
  const conflict =
    checked &&
    (conflictRefsQuery.data?.refs.some(
      (refName) => !refName.isRemote && refName.name === normalizedValue,
    ) ??
      false);
  const state = checked ? (conflict ? "conflict" : "available") : "checking";

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => {
    onStatusChangeRef.current?.(normalizedValue === null ? null : { name: normalizedValue, state });
  }, [normalizedValue, state]);
  // The send gate must not outlive the input (e.g. switching back to
  // "Current checkout"), or it would block sends it no longer applies to.
  useEffect(() => () => onStatusChangeRef.current?.(null), []);

  return (
    <input
      type="text"
      value={value}
      onChange={(event) => onValueChange(sanitizeWorktreeBranchNameInput(event.target.value))}
      placeholder="custom branch name"
      spellCheck={false}
      autoComplete="off"
      aria-label="Branch name for the new worktree"
      data-composer-context-control
      aria-invalid={conflict || undefined}
      title={conflict ? `Branch "${normalizedValue}" already exists.` : undefined}
      className={cn(
        "h-7 w-44 min-w-0 shrink rounded-md bg-transparent px-2 font-mono text-xs outline-none transition-colors sm:h-6",
        "placeholder:font-sans placeholder:text-muted-foreground/50",
        "hover:bg-muted/40 focus:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
        conflict ? "text-destructive" : "text-muted-foreground/70 focus:text-foreground/80",
      )}
    />
  );
}
