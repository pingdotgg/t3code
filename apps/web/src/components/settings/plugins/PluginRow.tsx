import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { ChevronUpIcon, RotateCwIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  pluginContributionKey,
  pluginPartNotesAtom,
  pluginSettingsPanelAtom,
  pluginWebFailuresAtom,
} from "../../../plugins/pluginRegistry";
import { pluginEnvironment } from "../../../state/plugins";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel } from "../../ui/collapsible";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Switch } from "../../ui/switch";
import { SettingsRow } from "../settingsLayout";
import { PluginSettingsRows } from "./PluginSettingsRows";

const FAILURE_STAGES = {
  discovery: "Not found",
  duplicate: "Duplicate id",
  manifest: "Invalid manifest",
  compatibility: "Incompatible",
  load: "Failed to load",
  activate: "Failed to start",
  crash: "Stopped the server",
  skipped: "Not started",
} as const;

export function PluginRow({
  environmentId,
  plugin,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
}) {
  const canManage = useAtomValue(pluginEnvironment.setPluginEnabled.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(pluginEnvironment.setPluginEnabled, "plugin enabled");
  const reload = useAtomCommand(pluginEnvironment.reloadPlugin, "plugin reload");
  const uninstall = useAtomCommand(pluginEnvironment.uninstallPlugin, "plugin removal");
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const customSettings = useAtomValue(
    pluginSettingsPanelAtom(pluginContributionKey(environmentId, plugin.id)),
  );
  const webFailure = useAtomValue(pluginWebFailuresAtom(plugin.id)).get(environmentId);
  const partNotes = useAtomValue(pluginPartNotesAtom(plugin.id)).get(environmentId) ?? [];
  const hasSettings = customSettings !== undefined || plugin.hasSettings;
  const whileBusy = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  const unlink = plugin.source === "dev";
  // Removing it would delete data the id's other folders use, so its failure says what to delete.
  const duplicate = plugin.failure?.stage === "duplicate";
  const { failure, serverFailure, folder } = plugin;
  const problems = [
    ...(failure === undefined ? [] : [`${FAILURE_STAGES[failure.stage]}: ${failure.message}`]),
    ...(serverFailure === undefined
      ? []
      : [
          `Failed while running: ${serverFailure}`,
          // Turning a plugin off clears its failures on the server, so this one came after.
          ...(plugin.enabled
            ? []
            : ["Some of its code is still running. Restarting T3 Code stops it."]),
        ]),
    ...(webFailure === undefined ? [] : [`Web part failed: ${webFailure}`]),
  ];
  const row = (
    <SettingsRow
      title={plugin.name}
      description={
        <>
          {plugin.description}
          {plugin.permissions.length > 0 ? (
            <span className="block">
              Says it uses: {plugin.permissions.join(", ")}. T3 Code doesn't enforce this.
            </span>
          ) : null}
          {plugin.unknownManifestKeys === undefined ? null : (
            <span className="block">
              T3 Code ignores these keys in its t3-plugin.json:{" "}
              {plugin.unknownManifestKeys.join(", ")}. Check them for typos.
            </span>
          )}
          {partNotes.map((note) => (
            <span key={note} className="block">
              {note}
            </span>
          ))}
        </>
      }
      status={
        problems.length === 0 ? undefined : (
          <div className="flex flex-wrap items-center gap-2">
            {problems.map((problem) => (
              <span key={problem} className="text-destructive">
                {problem}
              </span>
            ))}
          </div>
        )
      }
      control={
        <>
          {hasSettings ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Settings for ${plugin.name}`}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              {settingsOpen ? (
                <ChevronUpIcon className="size-4" />
              ) : (
                <SlidersHorizontalIcon className="size-4" />
              )}
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy || !canManage}
            aria-label={`Reload ${plugin.name}`}
            onClick={() =>
              void whileBusy(() => reload({ environmentId, input: { pluginId: plugin.id } }))
            }
          >
            <RotateCwIcon className="size-4" />
          </Button>
          {duplicate ? null : (
            <RemovePluginPopover
              name={plugin.name}
              unlink={unlink}
              folder={unlink ? folder : undefined}
              disabled={busy || !canManage}
              onRemove={() =>
                whileBusy(() => uninstall({ environmentId, input: { pluginId: plugin.id } }))
              }
            />
          )}
          <Switch
            checked={plugin.enabled}
            disabled={busy || !canManage}
            aria-label={`Enable ${plugin.name}`}
            onCheckedChange={(enabled) =>
              void whileBusy(() =>
                setEnabled({ environmentId, input: { pluginId: plugin.id, enabled } }),
              )
            }
          />
        </>
      }
    />
  );
  if (!hasSettings) return row;
  return (
    <>
      {row}
      {/* `contents`, so the card's line between rows falls inside the panel and slides in with it. */}
      <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen} className="contents">
        <CollapsiblePanel>
          <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
            <PluginSettingsRows
              environmentId={environmentId}
              plugin={plugin}
              customSettings={customSettings}
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </>
  );
}

/** The remove button and the popup that confirms it, or Unlink for a plugin loaded from a folder. */
function RemovePluginPopover({
  name,
  unlink,
  folder,
  disabled,
  onRemove,
}: {
  readonly name: string;
  readonly unlink: boolean;
  /** The folder unlinked, named in the popup. */
  readonly folder: string | undefined;
  readonly disabled: boolean;
  readonly onRemove: () => Promise<unknown>;
}) {
  const label = unlink ? "Unlink" : "Remove";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={disabled}
            aria-label={`${label} ${name}`}
          />
        }
      >
        <Trash2Icon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="md">
        <div className="flex flex-col gap-3">
          {folder === undefined ? null : (
            <p className="text-muted-foreground text-xs">
              Stops loading <span className="break-all font-mono">{folder}</span>. The folder stays.
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            This also deletes its settings, secrets and stored data, and can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <PopoverClose render={<Button size="sm" variant="ghost" disabled={disabled} />}>
              Cancel
            </PopoverClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={disabled}
              onClick={() => void onRemove()}
            >
              {label} {name}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
