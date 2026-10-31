/**
 * Settings > Layout (pen tmkl7): the template new panes open from
 * ("Your layout") and where opened things land ("Behavior"). Both live in
 * client settings and apply to every project and environment on this device.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_LAYOUT_TEMPLATE,
  DEFAULT_LAYOUT_SETTINGS,
  type LayoutNewTabPosition,
  type LayoutSidePaneOpensOn,
  type LayoutSidePanePlacement,
  type LayoutTerminalPlacement,
  type LayoutWhenNoRoom,
  type LayoutSettings as LayoutSettingsValue,
  type LayoutTemplate,
} from "@t3tools/contracts";
import {
  ArrowRightToLineIcon,
  Columns2Icon,
  Columns3Icon,
  FileDiffIcon,
  FoldHorizontalIcon,
  FolderTreeIcon,
  GlobeIcon,
  HistoryIcon,
  PanelBottomIcon,
  PlusIcon,
  RotateCcwIcon,
  SquarePlusIcon,
  Undo2Icon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import {
  useClientLayoutSettings,
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";
import { useLayoutStore } from "../../layout/layoutStore";
import { layoutTemplatesEqual } from "../../layout/layoutTemplate";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { LayoutEditor } from "./LayoutEditor";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTarget,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface PlacementOption<Value extends string> {
  value: Value;
  label: string;
  icon: LucideIcon;
}

const TERMINAL_OPTIONS: ReadonlyArray<PlacementOption<LayoutTerminalPlacement>> = [
  { value: "attached-below", label: "Below the chat", icon: PanelBottomIcon },
  { value: "new-tab", label: "In a new tab", icon: SquarePlusIcon },
  { value: "new-column", label: "In a new column", icon: Columns2Icon },
];

const SIDE_PANE_OPTIONS: ReadonlyArray<PlacementOption<LayoutSidePanePlacement>> = [
  { value: "beside-chat", label: "Beside the chat", icon: Columns2Icon },
  { value: "new-tab", label: "In a new tab", icon: SquarePlusIcon },
  { value: "new-column", label: "At the end of the strip", icon: ArrowRightToLineIcon },
];

const NEW_TAB_OPTIONS: ReadonlyArray<PlacementOption<LayoutNewTabPosition>> = [
  { value: "after-current", label: "After the current tab", icon: PlusIcon },
  { value: "end", label: "At the end", icon: ArrowRightToLineIcon },
];

const SIDE_PANE_OPENS_ON_OPTIONS: ReadonlyArray<PlacementOption<LayoutSidePaneOpensOn>> = [
  { value: "last-used", label: "Last used", icon: HistoryIcon },
  { value: "diff", label: "Diff", icon: FileDiffIcon },
  { value: "files", label: "Files", icon: FolderTreeIcon },
  { value: "browser", label: "Browser", icon: GlobeIcon },
  { value: "pull-request", label: "Pull request", icon: PullRequestGlyph.pullRequest },
];

const WHEN_NO_ROOM_OPTIONS: ReadonlyArray<PlacementOption<LayoutWhenNoRoom>> = [
  { value: "shrink-then-scroll", label: "Shrink, then scroll", icon: Columns3Icon },
  { value: "always-shrink", label: "Always shrink", icon: FoldHorizontalIcon },
  { value: "always-scroll", label: "Always scroll", icon: ArrowRightToLineIcon },
];

/** Undo steps kept during this visit. */
const UNDO_LIMIT = 20;

export function LayoutSettings() {
  const layout = useClientLayoutSettings();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [steps, setSteps] = useState<LayoutTemplate[]>([]);
  const template = layout.template;

  const saveTemplate = (next: LayoutTemplate) => {
    updateClientSettings({ layout: { template: next } });
    // Companions opened at a remembered size should follow the new template.
    useLayoutStore.getState().forgetCompanionShares();
  };
  const editTemplate = (next: LayoutTemplate) => {
    if (layoutTemplatesEqual(next, template)) return;
    setSteps([...steps, template].slice(-UNDO_LIMIT));
    saveTemplate(next);
  };
  const undo = () => {
    const previous = steps.at(-1);
    if (!previous) return;
    setSteps(steps.slice(0, -1));
    saveTemplate(previous);
  };
  const reset = () => editTemplate(DEFAULT_LAYOUT_TEMPLATE);
  // Pointing at "When it doesn't fit" shows the strip past the edges (pen Nm9FG).
  const [previewingNoRoom, setPreviewingNoRoom] = useState(false);
  const setBehavior = (patch: Partial<LayoutSettingsValue>) => {
    updateClientSettings({ layout: patch });
    // A terminal or side pane dragged somewhere reopens there until a
    // placement is chosen here.
    if ("terminalPlacement" in patch || "sidePanePlacement" in patch) {
      useLayoutStore.getState().forgetCompanionShares();
    }
  };
  const terminalKey = shortcutLabelForCommand(keybindings, "terminal.toggle");
  const sidePaneKey = shortcutLabelForCommand(keybindings, "rightPanel.toggle");
  const newTabKey = shortcutLabelForCommand(keybindings, "tab.new");

  return (
    <SettingsPageContainer>
      <section className="space-y-2">
        <YourLayoutHeader
          canUndo={steps.length > 0}
          canReset={!layoutTemplatesEqual(template, DEFAULT_LAYOUT_TEMPLATE)}
          onUndo={undo}
          onReset={reset}
        />
        <LayoutEditor
          template={template}
          onChange={editTemplate}
          stripPreview={previewingNoRoom ? layout.whenNoRoom : null}
        />
      </section>
      <SettingsSection title="Behavior">
        <PlacementRow
          {...searchableSetting("layout-terminal-placement")}
          title="Terminal"
          description={`Where ${terminalKey ?? "the terminal shortcut"} opens it.`}
          value={layout.terminalPlacement}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.terminalPlacement}
          options={TERMINAL_OPTIONS}
          onChange={(terminalPlacement) => setBehavior({ terminalPlacement })}
        />
        <PlacementRow
          {...searchableSetting("layout-side-pane-placement")}
          title="Side pane"
          description={`Where ${sidePaneKey ?? "the side pane shortcut"} opens diffs, files, the browser and PRs.`}
          value={layout.sidePanePlacement}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.sidePanePlacement}
          options={SIDE_PANE_OPTIONS}
          onChange={(sidePanePlacement) => setBehavior({ sidePanePlacement })}
        />
        <PlacementRow
          {...searchableSetting("layout-side-pane-opens-on")}
          title="Side pane opens on"
          description={`The tab ${sidePaneKey ?? "the side pane"} shows first.`}
          value={layout.sidePaneOpensOn}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.sidePaneOpensOn}
          options={SIDE_PANE_OPENS_ON_OPTIONS}
          onChange={(sidePaneOpensOn) => setBehavior({ sidePaneOpensOn })}
        />
        <PlacementRow
          {...searchableSetting("layout-new-tab-position")}
          title="New tabs"
          description={`Where ${newTabKey ?? "a new tab"} adds a tab.`}
          value={layout.newTabPosition}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.newTabPosition}
          options={NEW_TAB_OPTIONS}
          onChange={(newTabPosition) => setBehavior({ newTabPosition })}
        />
        <PlacementRow
          {...searchableSetting("layout-when-no-room")}
          title="When it doesn't fit"
          description="What happens when a new pane has no room."
          value={layout.whenNoRoom}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.whenNoRoom}
          options={WHEN_NO_ROOM_OPTIONS}
          onChange={(whenNoRoom) => setBehavior({ whenNoRoom })}
          onPreviewChange={setPreviewingNoRoom}
        />
      </SettingsSection>
      {isElectron && isMacPlatform(navigator.platform) ? <TrackpadSection /> : null}
    </SettingsPageContainer>
  );
}

/**
 * Three-finger swipes (macOS desktop app only, since only Electron hears
 * them). Device-local: it depends on this Mac's trackpad settings.
 */
function TrackpadSection() {
  const enabled = useClientSettings((settings) => settings.layoutThreeFingerSwipe === true);
  const settingsHydrated = useClientSettingsHydrated();
  return (
    <SettingsSection title="Trackpad">
      <SettingsRow
        {...searchableSetting("layout-three-finger-swipe")}
        title="Three-finger swipe"
        description='One flick moves one column, or one workspace up or down. In System Settings › Trackpad › More Gestures, set "Swipe between pages" to three fingers.'
        control={
          <Switch
            aria-label="Three-finger swipe"
            checked={enabled}
            disabled={!settingsHydrated}
            onCheckedChange={(layoutThreeFingerSwipe) =>
              updateClientSettings({ layoutThreeFingerSwipe })
            }
          />
        }
      />
    </SettingsSection>
  );
}

/** "Your layout" and its undo/reset actions (pen X7HAt). */
function YourLayoutHeader({
  canUndo,
  canReset,
  onUndo,
  onReset,
}: {
  canUndo: boolean;
  canReset: boolean;
  onUndo: () => void;
  onReset: () => void;
}) {
  const { id, title } = searchableSetting("layout-template");
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(id);
  return (
    <div
      ref={targetRef}
      id={id}
      tabIndex={-1}
      data-settings-scroll-target
      className="flex min-h-7 items-center justify-between gap-4 outline-none"
    >
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="text-label text-dim-foreground">{title}</h2>
      </div>
      {/* Ghost buttons hang by their 8px inline inset so the last label ends on the card edge. */}
      <div className="-me-2 flex shrink-0 items-center gap-1">
        <Button size="xs" variant="ghost-muted" disabled={!canUndo} onClick={onUndo}>
          <Undo2Icon aria-hidden />
          Undo
        </Button>
        <Button size="xs" variant="ghost-muted" disabled={!canReset} onClick={onReset}>
          <RotateCcwIcon aria-hidden />
          Reset
        </Button>
      </div>
    </div>
  );
}

function PlacementRow<Value extends string>({
  id,
  title,
  description,
  value,
  defaultValue,
  options,
  onChange,
  onPreviewChange,
}: {
  id: string;
  title: string;
  description: string;
  value: Value;
  defaultValue: Value;
  options: ReadonlyArray<PlacementOption<Value>>;
  onChange: (value: Value) => void;
  /** Called while the row is pointed at, focused or its menu is open. */
  onPreviewChange?: (active: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const active = hovered || focused || open;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the shared layout preview when the picker becomes inactive or unmounts.
  useEffect(() => {
    if (!onPreviewChange) return;
    onPreviewChange(active);
    return () => onPreviewChange(false);
  }, [active, onPreviewChange]);
  const byValue = new Map(options.map((option) => [option.value, option]));
  return (
    <SettingsRow
      id={id}
      {...(onPreviewChange
        ? {
            onPointerEnter: () => setHovered(true),
            onPointerLeave: () => setHovered(false),
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
          }
        : {})}
      title={title}
      description={description}
      resetAction={
        value !== defaultValue ? (
          <SettingResetButton label={title} onClick={() => onChange(defaultValue)} />
        ) : null
      }
      control={
        <Select
          value={value}
          onOpenChange={setOpen}
          onValueChange={(next) => {
            const option = byValue.get(next as Value);
            if (option) onChange(option.value);
          }}
        >
          <SelectTrigger size="sm" aria-label={title}>
            <SelectValue>
              {(current: Value) => {
                const option = byValue.get(current);
                if (!option) return current;
                const Icon = option.icon;
                return (
                  <span className="flex items-center gap-2">
                    <Icon aria-hidden className="size-3.5 text-muted-foreground" />
                    {option.label}
                  </span>
                );
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
