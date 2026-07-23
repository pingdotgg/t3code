import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  buildCheckoutWorkspaceChoices,
  type CheckoutOption,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  activeProjectId: CheckoutOption["projectId"];
  availableCheckouts: readonly CheckoutOption[];
  onWorkspaceChange?: (projectId: CheckoutOption["projectId"], mode: EnvMode) => void;
}

function formatCheckoutPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const homePrefix = "/Users/";
  if (normalized.startsWith(homePrefix)) {
    const segments = normalized.slice(homePrefix.length).split("/");
    if (segments.length > 1) {
      return `~/${segments.slice(1).join("/")}`;
    }
  }
  return normalized;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  activeProjectId,
  availableCheckouts,
  onWorkspaceChange,
}: BranchToolbarEnvModeSelectorProps) {
  const hasMultipleCheckouts = availableCheckouts.length > 1 && onWorkspaceChange !== undefined;
  const activeCheckout =
    availableCheckouts.find((checkout) => checkout.projectId === activeProjectId) ?? null;
  const checkoutChoices = useMemo(
    () => buildCheckoutWorkspaceChoices(availableCheckouts),
    [availableCheckouts],
  );
  const choiceValue = (projectId: CheckoutOption["projectId"], mode: EnvMode) =>
    checkoutChoices.find((choice) => choice.projectId === projectId && choice.mode === mode)
      ?.value ?? "";
  const envModeItems = useMemo(
    () =>
      hasMultipleCheckouts
        ? checkoutChoices.map((choice) => {
            const checkout = availableCheckouts.find(
              (candidate) => candidate.projectId === choice.projectId,
            )!;
            return {
              value: choice.value,
              label: `${checkout.title} — ${
                choice.mode === "local"
                  ? resolveCurrentWorkspaceLabel(activeWorktreePath)
                  : resolveEnvModeLabel("worktree")
              }`,
            };
          })
        : [
            { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
            { value: "worktree", label: resolveEnvModeLabel("worktree") },
          ],
    [activeWorktreePath, availableCheckouts, checkoutChoices, hasMultipleCheckouts],
  );

  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={
        hasMultipleCheckouts ? choiceValue(activeProjectId, effectiveEnvMode) : effectiveEnvMode
      }
      onValueChange={(value) => {
        if (!hasMultipleCheckouts) {
          onEnvModeChange(value as EnvMode);
          return;
        }
        const selected = checkoutChoices.find((option) => option.value === value);
        if (selected) {
          onWorkspaceChange(selected.projectId, selected.mode);
        }
      }}
      items={envModeItems}
    >
      <SelectTrigger variant="ghost" size="xs" className="font-medium" aria-label="Workspace">
        {effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        {hasMultipleCheckouts && activeCheckout ? (
          <span className="max-w-44 truncate">
            {activeCheckout.title} ·{" "}
            {effectiveEnvMode === "worktree"
              ? resolveEnvModeLabel("worktree")
              : resolveCurrentWorkspaceLabel(activeWorktreePath)}
          </span>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectPopup matchTriggerWidth={!hasMultipleCheckouts}>
        {hasMultipleCheckouts ? (
          availableCheckouts.map((checkout) => (
            <SelectGroup key={checkout.projectId}>
              <SelectGroupLabel>
                <span className="flex min-w-64 max-w-96 flex-col gap-0.5 py-0.5">
                  <span className="truncate text-foreground">{checkout.title}</span>
                  <span className="truncate font-normal text-muted-foreground/70">
                    {formatCheckoutPath(checkout.workspaceRoot)}
                  </span>
                </span>
              </SelectGroupLabel>
              <SelectItem value={choiceValue(checkout.projectId, "local")}>
                <span className="inline-flex items-center gap-1.5">
                  <FolderIcon className="size-3" />
                  Current checkout
                </span>
              </SelectItem>
              <SelectItem value={choiceValue(checkout.projectId, "worktree")}>
                <span className="inline-flex items-center gap-1.5">
                  <FolderGit2Icon className="size-3" />
                  New worktree…
                </span>
              </SelectItem>
            </SelectGroup>
          ))
        ) : (
          <SelectGroup>
            <SelectGroupLabel>Workspace</SelectGroupLabel>
            <SelectItem value="local">
              <span className="inline-flex items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                {resolveCurrentWorkspaceLabel(activeWorktreePath)}
              </span>
            </SelectItem>
            <SelectItem value="worktree">
              <span className="inline-flex items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                {resolveEnvModeLabel("worktree")}
              </span>
            </SelectItem>
          </SelectGroup>
        )}
      </SelectPopup>
    </Select>
  );
});
