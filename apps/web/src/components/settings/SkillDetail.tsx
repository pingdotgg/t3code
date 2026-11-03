import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { Check, Copy } from "lucide";
import { AlertTriangleIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { MorphIcon } from "../MorphIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SkillAgentIcon } from "./SkillAgents";
import type { SkillEnvironment } from "./SkillEnvironments";
import { useEscapeToList } from "./useEscapeToList";
import {
  skillConflict,
  type SkillAgent,
  type SkillRow,
  type SkillRowDetails,
} from "./toolsSettings.logic";

// The tree and the viewer pull in the file-tree and highlighter code.
const SkillFiles = lazy(() => import("./SkillFiles"));

/**
 * One skill: what it says, which agents load it, and its files. The settings
 * header names it and leads back to the list.
 */
export function SkillDetail({
  row,
  details,
  agents,
  environmentId,
  fleet,
  onBack,
  onUpdate,
  onRemove,
  onSync,
  syncing,
}: {
  row: SkillRow;
  details: SkillRowDetails;
  /** The agents on the environment whose copy is shown. */
  agents: ReadonlyArray<SkillAgent>;
  environmentId: EnvironmentId;
  /** With several environments in scope: which have the skill, and whose copy shows. */
  fleet?: {
    readonly on: ReadonlyArray<EnvironmentId>;
    readonly environments: ReadonlyArray<SkillEnvironment>;
    readonly shownFrom: EnvironmentId;
  };
  onBack: () => void;
  onUpdate: (() => void) | null;
  onRemove: (() => void) | null;
  /** Copy the skill to the environments in scope that lack it. */
  onSync: (() => void) | null;
  syncing: boolean;
}) {
  useEscapeToList(onBack);
  const loads = new Set(row.providers.map((provider) => provider.instanceId));
  const conflict = skillConflict(row, details);
  // A name can be several folders (a conflict, or a project copy over a global one).
  const [folderPath, setFolderPath] = useState(details.folder?.folder ?? null);
  const folder =
    details.copies.find((copy) => copy.folder === folderPath) ?? details.folder ?? null;
  const scripts = folder?.files.filter((file) => file.script).map((file) => file.path) ?? [];

  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "skill path" });

  return (
    <section aria-label={`${row.name} details`} className="min-w-0 space-y-4 px-3 sm:px-4">
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
          {onUpdate !== null ? (
            <Button size="xs" variant="outline" onClick={onUpdate}>
              Update
            </Button>
          ) : null}
          {onRemove !== null ? (
            <Button size="xs" variant="destructive-outline" onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
        {fleet !== undefined ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">On</span>
            {fleet.environments.map((environment) => {
              const has = fleet.on.includes(environment.environmentId);
              return (
                <Tooltip key={environment.environmentId}>
                  <TooltipTrigger
                    render={
                      <Badge variant={has ? "secondary" : "outline"} size="control" tabIndex={0} />
                    }
                  >
                    <span className={has ? undefined : "opacity-30"}>
                      <EnvironmentMachineIcon
                        aria-hidden
                        kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                        className="size-4"
                      />
                    </span>
                    {environment.label}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {!has
                      ? `${environment.label} doesn't have this skill.`
                      : environment.environmentId === fleet.shownFrom
                        ? `Showing ${environment.label}'s copy.`
                        : `${environment.label} has this skill.`}
                  </TooltipPopup>
                </Tooltip>
              );
            })}
            <span className="flex-1" />
            {onSync !== null || syncing ? (
              <Button size="xs" variant="outline" disabled={syncing} onClick={onSync ?? undefined}>
                {syncing ? <Spinner /> : null}
                Copy to{" "}
                {fleet.environments
                  .filter((environment) => !fleet.on.includes(environment.environmentId))
                  .map((environment) => environment.label)
                  .join(", ")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {conflict !== null || scripts.length > 0 || details.installed !== null ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {details.installed !== null ? (
              <span>
                From <span className="font-mono text-foreground">{details.installed.source}</span>
              </span>
            ) : null}
            {conflict !== null ? <span className="text-warning-foreground">{conflict}</span> : null}
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
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {folder.folder}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Copy path"
                    onClick={() => copyToClipboard(folder.folder, undefined)}
                  />
                }
              >
                <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
              </TooltipTrigger>
              <TooltipPopup side="top">{isCopied ? "Copied" : "Copy path"}</TooltipPopup>
            </Tooltip>
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
