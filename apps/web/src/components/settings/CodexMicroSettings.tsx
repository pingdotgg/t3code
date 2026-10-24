import {
  CODEX_MICRO_STATUS_COLORS,
  DEFAULT_CODEX_MICRO_CONTROLS,
  type CodexMicroAction,
  type CodexMicroAgentMode,
  type CodexMicroControlId,
  type CodexMicroKnobMode,
  type CodexMicroSettings,
} from "@t3tools/contracts";
import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  CODEX_MICRO_ACTION_GROUPS,
  codexMicroActionKey,
  describeCodexMicroAction,
  resolveCodexMicroControl,
} from "../../codexMicro/codexMicroActions";
import { useCodexMicroSnapshot } from "../../codexMicro/codexMicroStore";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useQuietThreadShells } from "../../state/entities";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SelectButton } from "../ui/select";
import { Switch } from "../ui/switch";
import { CodexMicroActionIcon, CodexMicroDevicePreview } from "./CodexMicroDevicePreview";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const AGENT_MODES: ReadonlyArray<{
  value: CodexMicroAgentMode;
  label: string;
  description: string;
}> = [
  {
    value: "priority",
    label: "Priority threads",
    description: "Waiting, unread, and active threads first",
  },
  { value: "pinned", label: "Pinned threads", description: "First six threads in Pinned" },
  {
    value: "recent",
    label: "Most recent threads",
    description: "First six recently updated threads",
  },
];

const KNOB_MODES: ReadonlyArray<{ value: CodexMicroKnobMode; label: string; description: string }> =
  [
    {
      value: "agents",
      label: "Agent keys",
      description: "Turn to choose an agent key, click to open its thread",
    },
    {
      value: "threads",
      label: "Thread switching",
      description: "Turn to move between threads, click for the command palette",
    },
    { value: "custom", label: "Custom", description: "Choose an action for each turn and click" },
  ];

const BRIGHTNESS = [0.25, 0.5, 0.8, 1] as const;
const AUTO_DIM: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: "Off" },
  { value: 60_000, label: "1 minute" },
  { value: 180_000, label: "3 minutes" },
  { value: 600_000, label: "10 minutes" },
  { value: 1_800_000, label: "30 minutes" },
  { value: 3_600_000, label: "1 hour" },
];

const STATUS_LEGEND = [
  ["working", "Working"],
  ["needs-input", "Needs you"],
  ["done", "Unread"],
  ["error", "Error"],
  ["idle", "Idle"],
] as const;

const COMMAND_KEY_ROWS: ReadonlyArray<[CodexMicroControlId, string, string]> = [
  ["ACT06", "Key 1", "Third row, left"],
  ["ACT07", "Key 2", "Third row"],
  ["ACT08", "Key 3", "Third row"],
  ["ACT09", "Key 4", "Third row, right"],
  ["ACT10", "Wide key", "Bottom row"],
  ["ACT11", "Wide key, right switch", "Bottom row"],
  ["ACT12", "Corner key", "Bottom row, right"],
];
const STICK: ReadonlyArray<[CodexMicroControlId, string]> = [
  ["JOY_UP", "Up"],
  ["JOY_RIGHT", "Right"],
  ["JOY_DOWN", "Down"],
  ["JOY_LEFT", "Left"],
];
const KNOB: ReadonlyArray<[CodexMicroControlId, string]> = [
  ["ENC_CC", "Turn left"],
  ["ENC_CW", "Turn right"],
  ["ENC", "Click"],
];

const controlRowId = (control: CodexMicroControlId) => `codex-micro-${control}`;
const agentRowId = (index: number) => `codex-micro-agent-${index}`;

function openRowMenu(id: string) {
  const row = document.getElementById(id);
  row?.scrollIntoView({ block: "center", behavior: "smooth" });
  row?.querySelector<HTMLButtonElement>("[data-codex-micro-trigger]")?.click();
}

// Read the latest stored value so quick successive edits don't overwrite each other.
const save = (patch: Partial<CodexMicroSettings>) =>
  void updateClientSettings({ codexMicro: { ...getClientSettings().codexMicro, ...patch } });

function OptionMenu<T>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ value: T; label: string }>;
  readonly onChange: (value: T) => void;
}) {
  const index = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.value),
  );
  return (
    <Menu>
      <MenuTrigger
        aria-label={props.label}
        render={<SelectButton size="sm" />}
        className="w-auto min-w-0"
      >
        {props.options[index]?.label}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={String(index)}
          onValueChange={(next) => props.onChange(props.options[Number(next)]!.value)}
        >
          {props.options.map((option, i) => (
            <MenuRadioItem key={option.label} closeOnClick value={String(i)}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function ActionMenu(props: {
  readonly action: CodexMicroAction;
  readonly onChange: (action: CodexMicroAction) => void;
}) {
  const options = new Map(
    CODEX_MICRO_ACTION_GROUPS.flatMap((group) => group.options).map((option) => [
      option.key,
      option.action,
    ]),
  );
  return (
    <Menu>
      <MenuTrigger
        data-codex-micro-trigger
        aria-label={`Action: ${describeCodexMicroAction(props.action)}`}
        render={<SelectButton size="sm" />}
        className="w-auto min-w-0 max-w-60"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <CodexMicroActionIcon action={props.action} className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">{describeCodexMicroAction(props.action)}</span>
        </span>
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-96 overflow-y-auto">
        <MenuRadioGroup
          value={codexMicroActionKey(props.action)}
          onValueChange={(key) => {
            const action = options.get(String(key));
            if (action) props.onChange(action);
          }}
        >
          {CODEX_MICRO_ACTION_GROUPS.map((group, index) => (
            <MenuGroup key={group.title}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroupLabel>{group.title}</MenuGroupLabel>
              {group.options.map((option) => (
                <MenuRadioItem key={option.key} closeOnClick value={option.key}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuGroup>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

export function CodexMicroSettingsPanel() {
  const settings = useClientSettings((current) => current.codexMicro);
  const { loaded, device, slots, selectedSlot, pressedKeys, joystick } = useCodexMicroSnapshot();
  const environmentId = usePrimaryEnvironmentId();
  const threads = useQuietThreadShells()
    .filter(
      (thread) => thread.environmentId === environmentId && !thread.archivedAt && !thread.deletedAt,
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 15);

  // The page only exists while the device is attached.
  if (!loaded) return null;
  if (!device.connected) return <Navigate to="/settings/general" replace />;

  const actionFor = (control: CodexMicroControlId) =>
    resolveCodexMicroControl(control, settings.knobMode, settings.controls);
  const setControl = (control: CodexMicroControlId, action: CodexMicroAction) =>
    save({ controls: { ...getClientSettings().codexMicro.controls, [control]: action } });
  const setPin = (index: number, threadId: string | null) => {
    const pinnedThreads = Array.from({ length: 6 }, (_, i) => settings.pinnedThreads[i] ?? null);
    // A thread lives on one key at a time.
    for (let i = 0; i < pinnedThreads.length; i += 1) {
      if (threadId !== null && pinnedThreads[i] === threadId) pinnedThreads[i] = null;
    }
    pinnedThreads[index] = threadId;
    save({ pinnedThreads });
  };
  const controlRow = (control: CodexMicroControlId, title: ReactNode, description?: string) => (
    <SettingsRow
      key={control}
      id={controlRowId(control)}
      title={title}
      description={description}
      control={
        <ActionMenu
          action={settings.controls[control]}
          onChange={(action) => setControl(control, action)}
        />
      }
    />
  );
  const battery =
    device.batteryPercentage === null
      ? null
      : `${device.batteryPercentage}%${device.charging ? ", charging" : ""}`;

  return (
    <SettingsPageContainer>
      <div className="flex flex-col items-center gap-4 rounded-2xl border bg-muted/30 px-4 pt-7 pb-5">
        <CodexMicroDevicePreview
          slots={slots}
          selectedSlot={selectedSlot}
          pinnedThreads={settings.pinnedThreads}
          pressedKeys={pressedKeys}
          joystick={joystick}
          separateMicrophoneKeys={settings.separateMicrophoneKeys}
          actionFor={actionFor}
          onAgentKey={(index) => openRowMenu(agentRowId(index))}
          onControl={(control) =>
            openRowMenu(
              control.startsWith("JOY")
                ? controlRowId(control)
                : control.startsWith("ENC")
                  ? "codex-micro-knob"
                  : controlRowId(control),
            )
          }
        />
        <p className="text-xs text-muted-foreground">Click a key to change what it does.</p>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {STATUS_LEGEND.map(([status, label]) => (
            <span key={status} className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-full border border-black/10 dark:border-white/15"
                style={{
                  backgroundColor: `#${CODEX_MICRO_STATUS_COLORS[status].toString(16).padStart(6, "0")}`,
                }}
              />
              {label}
            </span>
          ))}
        </div>
      </div>

      <SettingsSection id="codex-micro-device" title="Device">
        <SettingsRow
          title="Codex Micro"
          description={
            device.firmwareVersion ? `Connected, firmware ${device.firmwareVersion}` : "Connected"
          }
          control={
            battery ? <span className="text-sm text-muted-foreground">{battery}</span> : null
          }
        />
      </SettingsSection>

      <SettingsSection id="codex-micro-agents" title="Agent keys">
        <SettingsRow
          title="Follow"
          description={AGENT_MODES.find((mode) => mode.value === settings.agentMode)?.description}
          control={
            <OptionMenu
              label="Agent keys follow"
              value={settings.agentMode}
              options={AGENT_MODES}
              onChange={(agentMode) => save({ agentMode })}
            />
          }
        />
        <SettingsRow
          title="Focus T3 Code with a single tap"
          description="Open the thread and bring T3 Code forward with one tap instead of a double tap."
          control={
            <Switch
              checked={settings.singleTapFocus}
              aria-label="Focus T3 Code with a single tap"
              onCheckedChange={(singleTapFocus) => save({ singleTapFocus })}
            />
          }
        />
        {slots.map((slot) => {
          const pinned = settings.pinnedThreads[slot.index] ?? null;
          return (
            <SettingsRow
              key={slot.index}
              id={agentRowId(slot.index)}
              title={`Key ${slot.index + 1}`}
              description={slot.title ?? "No thread"}
              control={
                <OptionMenu
                  label={`Agent key ${slot.index + 1}`}
                  value={pinned}
                  options={[
                    { value: null, label: "Automatic" },
                    ...(pinned && !threads.some((thread) => thread.id === pinned)
                      ? [{ value: pinned, label: slot.title ?? "Pinned thread" }]
                      : []),
                    ...threads.map((thread) => ({
                      value: thread.id as string | null,
                      label: thread.title,
                    })),
                  ]}
                  onChange={(threadId) => setPin(slot.index, threadId)}
                />
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection id="codex-micro-keys" title="Command keys">
        <SettingsRow
          title="Use separate microphone keys"
          description="Map the two switches beneath the wide key separately."
          control={
            <Switch
              checked={settings.separateMicrophoneKeys}
              aria-label="Use separate microphone keys"
              onCheckedChange={(separateMicrophoneKeys) => save({ separateMicrophoneKeys })}
            />
          }
        />
        {COMMAND_KEY_ROWS.filter(
          ([control]) => control !== "ACT11" || settings.separateMicrophoneKeys,
        ).map(([control, title, description]) =>
          controlRow(
            control,
            control === "ACT10" && settings.separateMicrophoneKeys
              ? "Wide key, left switch"
              : title,
            description,
          ),
        )}
      </SettingsSection>

      <SettingsSection id="codex-micro-knob" title="Knob">
        <SettingsRow
          title="Mode"
          description={KNOB_MODES.find((mode) => mode.value === settings.knobMode)?.description}
          control={
            <OptionMenu
              label="Knob mode"
              value={settings.knobMode}
              options={KNOB_MODES}
              onChange={(knobMode) => save({ knobMode })}
            />
          }
        />
        {settings.knobMode === "custom"
          ? KNOB.map(([control, title]) => controlRow(control, title))
          : null}
      </SettingsSection>

      <SettingsSection id="codex-micro-stick" title="Analog stick">
        {STICK.map(([control, title]) => controlRow(control, title))}
      </SettingsSection>

      <SettingsSection id="codex-micro-lighting" title="Lighting">
        <SettingsRow
          title="Brightness"
          control={
            <OptionMenu
              label="Brightness"
              value={BRIGHTNESS.reduce((best, value) =>
                Math.abs(value - settings.brightness) < Math.abs(best - settings.brightness)
                  ? value
                  : best,
              )}
              options={BRIGHTNESS.map((value) => ({ value, label: `${Math.round(value * 100)}%` }))}
              onChange={(brightness) => save({ brightness })}
            />
          }
        />
        <SettingsRow
          title="Auto-dim"
          description="Turn lighting off after inactivity. It comes back when you use the device or a thread changes state."
          control={
            <OptionMenu
              label="Auto-dim"
              value={settings.autoDimMs}
              options={AUTO_DIM}
              onChange={(autoDimMs) => save({ autoDimMs })}
            />
          }
        />
        <SettingsRow
          title="Key backlight"
          description="Light the command keycaps."
          control={
            <Switch
              checked={settings.keysBacklight}
              aria-label="Key backlight"
              onCheckedChange={(keysBacklight) => save({ keysBacklight })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="codex-micro-layout" title="Layout">
        <SettingsRow
          title="Reset layout"
          description="Restore the command keys, knob, and analog stick to their defaults."
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => save({ controls: DEFAULT_CODEX_MICRO_CONTROLS, knobMode: "agents" })}
            >
              Reset
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
