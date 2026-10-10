import type { EditorId, EnvironmentId, InstructionReadResult } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronLeftIcon, MoreHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAfterDelay } from "../../hooks/useAfterDelay";
import { openInEditorMenuLabel } from "../../editorLabels";
import { usePreferredEditor, useOpenInPreferredEditor } from "../../editorPreferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InstructionEditor, type InstructionText } from "./InstructionEditor";
import { InstructionAgentChip } from "./InstructionList";
import {
  entryFileName,
  instructionActions,
  instructionChips,
  type InstructionData,
  type InstructionPlan,
  type InstructionRow,
} from "./InstructionsSettings.logic";
import { copyPath, useEscapeToList } from "./SkillDetailChrome";
import type { SkillsContext } from "./SkillsSettings.logic";

/** How long the file area waits before showing placeholders for a quick read. */
const SKELETON_DELAY_MS = 150;

type LoadState =
  | { status: "loading" }
  | { status: "ready"; text: InstructionText; tooLarge: boolean; resave: boolean }
  | { status: "error" };

const toLoadState = (value: InstructionReadResult | null): LoadState =>
  value
    ? {
        status: "ready",
        text: { contents: value.contents ?? "", revision: value.revision },
        tooLarge: value.tooLarge,
        resave: false,
      }
    : { status: "error" };

export function InstructionDetail({
  row,
  ctx,
  data,
  environmentId,
  projectRoot,
  availableEditors,
  busy,
  locked,
  onBack,
  onPlan,
  onSaved,
}: {
  row: InstructionRow;
  ctx: SkillsContext;
  data: InstructionData;
  environmentId: EnvironmentId;
  projectRoot: string | null;
  availableEditors: readonly EditorId[];
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  /** The session can't change instructions. */
  locked: boolean;
  onBack: () => void;
  /** Turns agents on or off, moves, merges or deletes; a plan with a confirmation asks first. */
  onPlan: (plan: InstructionPlan) => void;
  /** A save went through, so the list can read the files again. */
  onSaved: () => void;
}) {
  useEscapeToList(onBack);
  const readInstruction = useAtomCommand(serverEnvironment.readInstruction, {
    reportFailure: false,
  });
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const { entry } = row;
  const id = entry.id;
  const fileName = entryFileName(entry);
  const canEdit = !entry.readOnly && !locked;
  const [mode, setMode] = useState<"edit" | "preview">("edit");

  const fetchText = useCallback(async () => {
    const result = await readInstruction({
      environmentId,
      input: { id, ...(projectRoot ? { cwd: projectRoot } : {}) },
    });
    return result._tag === "Success" ? result.value : null;
  }, [readInstruction, environmentId, id, projectRoot]);

  useEffect(() => {
    let cancelled = false;
    void fetchText().then((value) => {
      if (!cancelled) setLoad(toLoadState(value));
    });
    return () => {
      cancelled = true;
    };
  }, [fetchText]);

  // Bumped when the editor opens again from the file or from the person's text.
  const [editorVersion, setEditorVersion] = useState(0);
  const resolveConflict = useCallback(
    async (choice: "reload" | "keep", mine: string) => {
      const value = await fetchText();
      if (!value || value.tooLarge) return false;
      const fresh = { contents: value.contents ?? "", revision: value.revision };
      setLoad({
        status: "ready",
        // Keeping the person's text builds on the file as it is now, so the save is accepted.
        text: choice === "keep" ? { contents: mine, revision: fresh.revision } : fresh,
        tooLarge: false,
        resave: choice === "keep",
      });
      setEditorVersion((count) => count + 1);
      return true;
    },
    [fetchText],
  );

  const showSkeleton = useAfterDelay(load.status === "loading", SKELETON_DELAY_MS);
  const chips = useMemo(() => instructionChips(entry, ctx, data), [entry, ctx, data]);
  const actions = useMemo(() => instructionActions(row, ctx, data), [row, ctx, data]);
  const disabled = busy || locked;

  const [preferredEditor] = usePreferredEditor(availableEditors);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = () => {
    void (async () => {
      const result = await openInPreferredEditor(entry.path);
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to open file",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    })();
  };
  const canOpen = entry.exists && availableEditors.length > 0;

  return (
    <section aria-label={`${row.heading} details`} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button size="xs" variant="ghost-muted" onClick={onBack}>
          <ChevronLeftIcon />
          Skills
        </Button>
        <div className="min-w-0 flex-1 basis-40">
          <h2 className="truncate text-base font-semibold">
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="cursor-default" />}>
                {row.heading}
              </TooltipTrigger>
              <TooltipPopup>
                <span className="block font-mono break-all">{entry.path}</span>
              </TooltipPopup>
            </Tooltip>
          </h2>
          {row.headingNote !== "" && (
            <p className="truncate text-xs text-muted-foreground">{row.headingNote}</p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {canEdit && (
            <ToggleGroup
              aria-label="Edit or preview"
              variant="segmented"
              value={[mode]}
              onValueChange={(next) => {
                const picked = next[0];
                if (picked === "edit" || picked === "preview") setMode(picked);
              }}
            >
              <Toggle value="edit">Edit</Toggle>
              <Toggle value="preview">Preview</Toggle>
            </ToggleGroup>
          )}
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="More actions" />}
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {canOpen && (
                <MenuItem onClick={openInEditor}>{openInEditorMenuLabel(preferredEditor)}</MenuItem>
              )}
              <MenuItem onClick={() => copyPath(entry.path, "instruction path")}>
                Copy path
              </MenuItem>
              {actions.turnOnAll && (
                <MenuItem disabled={disabled} onClick={() => onPlan(actions.turnOnAll!)}>
                  Turn on for all agents
                </MenuItem>
              )}
              {actions.share && (
                <MenuItem disabled={disabled} onClick={() => onPlan(actions.share!.plan)}>
                  {actions.share.label}…
                </MenuItem>
              )}
              {actions.useGlobal && (
                <MenuItem disabled={disabled} onClick={() => onPlan(actions.useGlobal!)}>
                  Use Global instead…
                </MenuItem>
              )}
              {(actions.removeFromAgents || actions.remove) && <MenuSeparator />}
              {actions.removeFromAgents && (
                <MenuItem
                  variant="destructive"
                  disabled={disabled}
                  onClick={() => onPlan(actions.removeFromAgents!)}
                >
                  Remove from agents…
                </MenuItem>
              )}
              {actions.remove && (
                <MenuItem
                  variant="destructive"
                  disabled={disabled}
                  onClick={() => onPlan(actions.remove!)}
                >
                  Delete…
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        </div>
      </div>

      {entry.exists && (chips.length > 0 || actions.share) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Used by</span>
          {chips.map((chip) => (
            <InstructionAgentChip
              key={chip.agent.instanceId}
              chip={chip}
              agents={ctx.installed}
              busy={busy}
              locked={locked}
              onPlan={onPlan}
            />
          ))}
          {actions.share && (
            <span className="ml-auto">
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => onPlan(actions.share!.plan)}
              >
                {actions.share.label}
              </Button>
            </span>
          )}
        </div>
      )}

      {load.status === "loading" && (
        <div
          role="status"
          aria-label="Loading the file"
          className="space-y-2 rounded-xl border border-border/60 bg-card/40 p-4"
        >
          {showSkeleton ? (
            <>
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </>
          ) : (
            <span className="block h-12" />
          )}
        </div>
      )}
      {load.status === "error" && (
        <div className="space-y-2 rounded-xl border border-border/60 bg-card/40 p-4 text-sm">
          <p className="text-warning-foreground">The file couldn't be read.</p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setLoad({ status: "loading" });
              void fetchText().then((value) => setLoad(toLoadState(value)));
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {load.status === "ready" && load.tooLarge && (
        <p className="rounded-xl border border-border/60 bg-card/40 p-4 text-sm text-warning-foreground">
          This file is too large to show here.
        </p>
      )}
      {load.status === "ready" && !load.tooLarge && (
        <InstructionEditor
          key={`${id}:${editorVersion}`}
          environmentId={environmentId}
          cwd={projectRoot}
          id={id}
          fileName={fileName}
          initial={load.text}
          canEdit={canEdit}
          mode={mode}
          creating={!entry.exists}
          resave={load.resave}
          onSaved={onSaved}
          onResolve={resolveConflict}
        />
      )}
    </section>
  );
}
