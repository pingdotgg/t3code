import type { EnvironmentId } from "@t3tools/contracts";
import { AlertTriangleIcon, ArrowLeftIcon, MoreHorizontalIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useEffectEvent, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SkillAgentIcon } from "./SkillAgents";
import {
  skillAttention,
  type SkillAgent,
  type SkillRow,
  type SkillRowDetails,
} from "./toolsSettings.logic";

// The tree and the viewer pull in the file-tree and highlighter code.
const SkillFiles = lazy(() => import("./SkillFiles"));

/**
 * Escape goes from a skill back to the list. Settings leaves the page on
 * Escape from its own window listener, so this one runs first, in the capture
 * phase. Escape inside a field, dialog or menu belongs to that control.
 */
function useEscapeToList(onBack: () => void) {
  const goBack = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing)
      return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        'input,textarea,select,[contenteditable],[role="dialog"],[role="alertdialog"],[role="menu"]',
      )
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onBack();
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => goBack(event);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}

/**
 * One skill: what it says, which agents load it, and its files. Adapted from
 * the skill page in #17513.
 */
export function SkillDetail({
  row,
  details,
  agents,
  groupLabel,
  environmentId,
  onBack,
  onUpdate,
  onRemove,
}: {
  row: SkillRow;
  details: SkillRowDetails;
  agents: ReadonlyArray<SkillAgent>;
  /** The list section the skill came from, for the breadcrumb. */
  groupLabel: string;
  environmentId: EnvironmentId;
  onBack: () => void;
  onUpdate: (() => void) | null;
  onRemove: (() => void) | null;
}) {
  useEscapeToList(onBack);
  const loads = new Set(row.providers.map((provider) => provider.instanceId));
  const warning = skillAttention(row, details, agents);
  // A name can be several folders (a conflict, or a project copy over a global one).
  const [folderPath, setFolderPath] = useState(details.folder?.folder ?? null);
  const folder =
    details.copies.find((copy) => copy.folder === folderPath) ?? details.folder ?? null;
  const scripts = folder?.files.filter((file) => file.script).map((file) => file.path) ?? [];

  const copyPath = (path: string) => {
    void writeTextToClipboard(path, "skill path").then(
      (copied) => {
        if (copied) toastManager.add({ type: "success", title: "Path copied", description: path });
      },
      (error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      },
    );
  };

  return (
    <section aria-label={`${row.name} details`} className="min-w-0 space-y-4 px-3 sm:px-4">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <Button size="xs" variant="ghost-muted" onClick={onBack}>
          <ArrowLeftIcon className="sm:hidden" />
          <span className="sm:hidden">Back</span>
          <span className="hidden sm:inline">Skills</span>
        </Button>
        <span>/ {groupLabel}</span>
      </nav>
      <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words">{row.name}</h2>
          <p className="mt-1 text-sm break-words text-muted-foreground">
            {row.description || "No description yet."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Used by</span>
          {agents.length === 0 ? (
            <span className="text-xs text-muted-foreground">No agents are enabled.</span>
          ) : null}
          {agents.map((agent) => {
            const on = loads.has(agent.instanceId);
            return (
              <Tooltip key={agent.instanceId}>
                <TooltipTrigger
                  render={
                    <Badge variant={on ? "secondary" : "outline"} size="control" tabIndex={0} />
                  }
                >
                  <SkillAgentIcon agent={agent} agents={agents} active={on} />
                  {agent.displayName}
                </TooltipTrigger>
                <TooltipPopup>
                  {on
                    ? `${agent.displayName} loads this skill.`
                    : `${agent.displayName} doesn't load this skill.`}
                </TooltipPopup>
              </Tooltip>
            );
          })}
          <span className="flex-1" />
          {folder !== null || onUpdate !== null || onRemove !== null ? (
            <Menu>
              <MenuTrigger
                render={<Button size="icon-xs" variant="outline" aria-label="More actions" />}
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                {folder !== null ? (
                  <MenuItem onClick={() => copyPath(folder.folder)}>Copy path</MenuItem>
                ) : null}
                {onUpdate !== null ? <MenuItem onClick={onUpdate}>Update</MenuItem> : null}
                {onRemove !== null ? (
                  <MenuItem variant="destructive" onClick={onRemove}>
                    Remove
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
        {warning !== null || scripts.length > 0 || details.installed !== null ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {details.installed !== null ? (
              <span>
                From <span className="font-mono text-foreground">{details.installed.source}</span>
              </span>
            ) : null}
            {warning !== null ? (
              <span className="text-warning-foreground">{warning.detail}</span>
            ) : null}
            {scripts.length > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      className="flex cursor-default items-center gap-1 text-warning-foreground"
                    />
                  }
                >
                  <AlertTriangleIcon className="size-3.5 shrink-0" />
                  Includes scripts
                </TooltipTrigger>
                <TooltipPopup>
                  {scripts.slice(0, 8).join(", ")}
                  {scripts.length > 8 ? ` and ${scripts.length - 8} more` : ""}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card/40">
        {folder !== null ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
            {details.copies.length > 1 ? (
              <ToggleGroup
                aria-label="Copy of the skill"
                size="xs"
                value={[folder.folder]}
                onValueChange={(next) => {
                  if (next[0] !== undefined) setFolderPath(next[0]);
                }}
              >
                {details.copies.map((copy, index) => (
                  <Toggle key={copy.folder} value={copy.folder}>
                    Copy {index + 1}
                  </Toggle>
                ))}
              </ToggleGroup>
            ) : null}
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {folder.folder}
            </span>
          </div>
        ) : null}
        {folder === null ? (
          <p className="p-4 text-sm text-muted-foreground">
            This agent doesn't say where the skill's files are, so they can't be shown.
          </p>
        ) : (
          <Suspense
            fallback={
              <div role="status" aria-label="Loading the file viewer" className="space-y-2 p-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            }
          >
            <SkillFiles
              key={folder.folder}
              environmentId={environmentId}
              folder={folder.folder}
              files={folder.files}
            />
          </Suspense>
        )}
        {folder?.filesTruncated ? (
          <p className="border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
            Only some of this skill's files are shown.
          </p>
        ) : null}
      </div>
    </section>
  );
}
