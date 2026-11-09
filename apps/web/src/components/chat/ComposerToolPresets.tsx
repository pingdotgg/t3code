import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadToolPresets,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { toolPresetState, withThreadToolPreset } from "@t3tools/shared/agentTools";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { BlocksIcon, PencilIcon, PlusIcon } from "lucide-react";
import { memo, useState } from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ThreadShell } from "../../types";
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
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { ToolPresetDialog } from "./ToolPresetDialog";
import { useComposerMenuState } from "./useComposerMenuState";

export interface ComposerToolPreset {
  readonly name: string;
  /** On for this thread, from its own switch or from settings. */
  readonly on: boolean;
  /** Settings turn on only some of its tools and the thread has no switch of its own. */
  readonly partial: boolean;
}

export interface ComposerToolPresets {
  readonly presets: ReadonlyArray<ComposerToolPreset>;
  /** Why the switches can't change right now, if they can't. */
  readonly disabledReason: string | null;
  readonly onToggle: (name: string, on: boolean) => void;
  /** Whether this connection may create, change and delete presets. */
  readonly canEdit: boolean;
  /** Opens the editor for a preset, or for a new one with null. */
  readonly onEdit: (name: string | null) => void;
  /** The open editor's preset, null for a new one; undefined when it is closed. */
  readonly editing: string | null | undefined;
  readonly onEditClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
}

/**
 * The environment's tool presets as one thread has them. A server thread's
 * switch is saved at once and reaches its next message; a new thread's waits
 * in its draft until it starts. Presets are made and changed here too, so
 * Settings only holds the defaults. Null when there is nothing to show.
 */
export function useComposerToolPresets(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
  readonly routeKind: "server" | "draft";
  readonly routeThreadRef: ScopedThreadRef;
  readonly draftId: DraftId | null;
  readonly threadShell: ThreadShell | null;
  readonly running: boolean;
}): ComposerToolPresets | null {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(input.environmentId));
  const canEdit = useEnvironmentsWithScope(
    [{ environmentId: input.environmentId }],
    AuthSettingsWriteScope,
  ).has(input.environmentId);
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const draftSwitches = useComposerDraftStore((store) =>
    input.routeKind === "draft" && input.draftId
      ? store.getDraftSession(input.draftId)?.toolPresets
      : undefined,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setThreadToolPresets = useOrchestrationCommand(threadEnvironment.setToolPresets, {
    label: "set tool presets",
  });
  const presets = settings?.toolPresets ?? {};
  const names = Object.keys(presets).toSorted((left, right) => left.localeCompare(right));
  if (!settings || (names.length === 0 && !canEdit)) return null;
  const isServerThread = input.routeKind === "server" && input.threadShell !== null;
  const switches: ThreadToolPresets | undefined = isServerThread
    ? input.threadShell?.toolPresets
    : draftSwitches;
  const effective = resolveProjectSettings(settings, input.projectId).settings;
  const stateOf = (name: string) => toolPresetState(effective, presets[name]!);
  return {
    presets: names.map((name) => {
      const own = switches?.[name];
      const state = stateOf(name);
      return {
        name,
        on: own ?? state === "on",
        partial: own === undefined && state === "mixed",
      };
    }),
    disabledReason:
      isServerThread && input.running ? "Tools can change once the thread is idle." : null,
    onToggle: (name, on) => {
      const next = withThreadToolPreset(switches, name, on, stateOf(name));
      if (isServerThread) {
        void setThreadToolPresets({
          environmentId: input.environmentId,
          input: { threadId: input.routeThreadRef.threadId, toolPresets: next },
        });
      } else if (input.draftId) {
        setDraftThreadContext(input.draftId, { toolPresets: next });
      }
    },
    canEdit,
    onEdit: setEditing,
    editing,
    onEditClose: () => setEditing(undefined),
    environmentId: input.environmentId,
    projectId: input.projectId,
    cwd: input.cwd,
  };
}

/** The presets as switches, for the chip's menu or the overflow menu. */
export function ComposerToolPresetsSection({ toolPresets }: { toolPresets: ComposerToolPresets }) {
  const composerFloatingLayerProps = useComposerMenuProps();
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Tool presets</MenuGroupLabel>
        {toolPresets.presets.length === 0 ? (
          <p className="max-w-64 px-2 py-1 text-muted-foreground text-xs">
            Group skills and MCP servers you use together, then turn them on or off for a thread
            here.
          </p>
        ) : null}
        {toolPresets.presets.map((preset) => (
          <MenuCheckboxItem
            key={preset.name}
            variant="switch"
            checked={preset.on}
            disabled={toolPresets.disabledReason !== null}
            onCheckedChange={(checked) => toolPresets.onToggle(preset.name, checked)}
          >
            <span className="block truncate">{preset.name}</span>
            {preset.partial ? (
              <span className="block text-muted-foreground text-xs">Some of its tools are on</span>
            ) : null}
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
      {toolPresets.disabledReason !== null ? (
        <p className="max-w-64 px-2 py-1 text-muted-foreground text-xs">
          {toolPresets.disabledReason}
        </p>
      ) : null}
      {toolPresets.canEdit ? (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => toolPresets.onEdit(null)}>
            <PlusIcon aria-hidden />
            New preset…
          </MenuItem>
          {toolPresets.presets.length > 0 ? (
            <MenuSub>
              <MenuSubTrigger>
                <PencilIcon aria-hidden />
                Edit preset
              </MenuSubTrigger>
              <MenuSubPopup {...composerFloatingLayerProps}>
                {toolPresets.presets.map((preset) => (
                  <MenuItem key={preset.name} onClick={() => toolPresets.onEdit(preset.name)}>
                    <span className="block max-w-48 truncate">{preset.name}</span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * The composer's Tools chip: an icon until a preset is on, then the preset's
 * name. It also holds the preset editor, which either menu opens.
 */
export const ComposerToolPresetsControl = memo(function ComposerToolPresetsControl(props: {
  toolPresets: ComposerToolPresets;
  size?: "sm" | "xs";
  hidden?: boolean;
}) {
  const size = props.size ?? "sm";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const { toolPresets } = props;
  const on = toolPresets.presets.filter((preset) => preset.on);
  const label = on.length === 1 ? on[0]!.name : on.length > 1 ? `${on.length} presets` : null;
  const tooltip =
    on.length === 0
      ? "Tool presets"
      : `Tool presets on for this thread: ${on.map((preset) => preset.name).join(", ")}`;
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <ComposerControl
                    size={size}
                    className="shrink-0 whitespace-nowrap"
                    aria-label={tooltip}
                  />
                }
              />
            }
          >
            <ComposerControlIcon icon={BlocksIcon} size={size} />
            {label !== null ? (
              <span data-composer-control-label className="max-w-32 truncate">
                {label}
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">{tooltip}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="start" {...composerFloatingLayerProps}>
          <ComposerToolPresetsSection toolPresets={toolPresets} />
        </MenuPopup>
      </Menu>
      {toolPresets.editing !== undefined ? (
        <ToolPresetDialog
          // A new editor for each preset, so its form starts from that preset.
          key={toolPresets.editing ?? ""}
          environmentId={toolPresets.environmentId}
          projectId={toolPresets.projectId}
          cwd={toolPresets.cwd}
          name={toolPresets.editing}
          onClose={toolPresets.onEditClose}
        />
      ) : null}
    </>
  );
});
