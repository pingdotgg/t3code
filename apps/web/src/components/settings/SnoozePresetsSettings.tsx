import { useState } from "react";
import {
  DEFAULT_SNOOZE_PRESETS,
  MAX_SNOOZE_PRESET_MINUTES,
  MAX_SNOOZE_PRESETS,
  SnoozePresetDay,
  type SnoozePresetSetting,
} from "@t3tools/contracts/settings";
import {
  resolveSnoozePreset,
  resolveSnoozePresets,
  snoozePresetId,
} from "@t3tools/client-runtime/state/thread-settled";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { PlusIcon, XIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { reconcileSnoozeDraft } from "./SnoozePresetsSettings.logic";
import { formatShortTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 24 * 60 } as const;
type DurationUnit = keyof typeof UNIT_MINUTES;
const UNIT_LABELS: Record<DurationUnit, string> = {
  minutes: "minutes",
  hours: "hours",
  days: "days",
};
const SINGULAR_UNIT_LABELS: Record<DurationUnit, string> = {
  minutes: "minute",
  hours: "hour",
  days: "day",
};

const WHEN_LABELS: Record<"after" | SnoozePresetDay, string> = {
  after: "In",
  today: "Today",
  tomorrow: "Tomorrow",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};
const WHEN_VALUES = ["after", ...SnoozePresetDay.literals] as const;

// Offered in order when adding, skipping any already in the list.
const ADD_CANDIDATES: ReadonlyArray<SnoozePresetSetting> = [
  ...DEFAULT_SNOOZE_PRESETS,
  { kind: "after", minutes: 30 },
  { kind: "at", day: "saturday", time: "09:00" },
  { kind: "after", minutes: 24 * 60 },
];

function splitMinutes(minutes: number): { amount: number; unit: DurationUnit } {
  if (minutes % UNIT_MINUTES.days === 0)
    return { amount: minutes / UNIT_MINUTES.days, unit: "days" };
  if (minutes % UNIT_MINUTES.hours === 0) {
    return { amount: minutes / UNIT_MINUTES.hours, unit: "hours" };
  }
  return { amount: minutes, unit: "minutes" };
}

function nextCandidate(presets: ReadonlyArray<SnoozePresetSetting>): SnoozePresetSetting {
  const used = new Set(presets.map(snoozePresetId));
  return (
    ADD_CANDIDATES.find((candidate) => !used.has(snoozePresetId(candidate))) ?? {
      kind: "after",
      minutes: 60,
    }
  );
}

const isSnoozePresetDay = Schema.is(SnoozePresetDay);

interface KindMemory {
  readonly minutes: number;
  readonly time: string;
}

function withWhen(
  preset: SnoozePresetSetting,
  when: string,
  memory: KindMemory,
): SnoozePresetSetting | null {
  if (when === "after") {
    return preset.kind === "after" ? preset : { kind: "after", minutes: memory.minutes };
  }
  if (!isSnoozePresetDay(when)) return null;
  return { kind: "at", day: when, time: preset.kind === "at" ? preset.time : memory.time };
}

/** Edits the snooze menu's options. Menus sort them by wake time, so rows keep the order they were added in. */
export function SnoozePresetsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const saved = settings.snoozePresets;
  // Edits build on a local draft, so a second edit before the first save echoes back
  // does not restore what the first one changed. Echoes of our own writes keep the draft.
  const [presets, setPresets] = useState(saved);
  // Row keys survive removals, so a row's in-progress field state stays with that row.
  const [keys, setKeys] = useState<ReadonlyArray<number>>(() => saved.map((_, index) => index));
  const [nextKey, setNextKey] = useState(saved.length);
  // Null forces the next render to adopt the saved value, as after a failed write.
  const [savedSource, setSavedSource] = useState<ReadonlyArray<SnoozePresetSetting> | null>(saved);
  // Environments disagree, so equal-looking edits and Reset must still write to all of them.
  const mixed = useScopedSettingsMixed(["snoozePresets"]);
  const [written, setWritten] = useState<ReadonlyArray<ReadonlyArray<SnoozePresetSetting>>>([]);
  const freshKeys = (count: number) => {
    setNextKey(nextKey + count);
    return Array.from({ length: count }, (_, index) => nextKey + index);
  };
  if (!Equal.equals(savedSource, saved)) {
    setSavedSource(saved);
    const reconciled = reconcileSnoozeDraft(written, saved);
    if (reconciled.adopt) {
      setWritten([]);
      setPresets(saved);
      setKeys(freshKeys(saved.length));
    } else {
      setWritten(reconciled.pending);
    }
  }
  const save = (
    snoozePresets: ReadonlyArray<SnoozePresetSetting>,
    nextKeys: ReadonlyArray<number> = keys,
  ) => {
    if (!mixed && Equal.equals(snoozePresets, presets)) return;
    setPresets(snoozePresets);
    setKeys(nextKeys);
    setWritten((previous) => [...previous, snoozePresets]);
    updateSettings(
      { snoozePresets },
      {
        onFailed: () => {
          setWritten([]);
          setSavedSource(null);
        },
      },
    );
  };
  const replaceAt = (index: number, next: SnoozePresetSetting) =>
    save(presets.map((preset, candidate) => (candidate === index ? next : preset)));

  return (
    <SettingsRow
      serverScoped
      settingKeys={["snoozePresets"]}
      {...searchableSetting("snooze-options")}
      description="Choices in every snooze menu, listed soonest first. Weekdays mean the next one after today."
      resetAction={
        !mixed && Equal.equals(presets, DEFAULT_SNOOZE_PRESETS) ? null : (
          <SettingResetButton
            label="snooze options"
            onClick={() => save(DEFAULT_SNOOZE_PRESETS, freshKeys(DEFAULT_SNOOZE_PRESETS.length))}
          />
        )
      }
    >
      <SnoozePresetList
        presets={presets}
        keys={keys}
        timestampFormat={settings.timestampFormat}
        onChange={replaceAt}
        onRemove={(index) =>
          save(
            presets.filter((_, candidate) => candidate !== index),
            keys.filter((_, candidate) => candidate !== index),
          )
        }
        onAdd={() => save([...presets, nextCandidate(presets)], [...keys, ...freshKeys(1)])}
      />
    </SettingsRow>
  );
}

function SnoozePresetList(props: {
  presets: ReadonlyArray<SnoozePresetSetting>;
  keys: ReadonlyArray<number>;
  timestampFormat: Parameters<typeof formatShortTimestamp>[1];
  onChange: (index: number, preset: SnoozePresetSetting) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  const nowMinute = useNowMinute();
  const now = new Date(`${nowMinute}Z`);
  const formatTime = (date: Date) =>
    formatShortTimestamp(date.toISOString(), props.timestampFormat);
  const seenIds = new Set<string>();
  const seenWakes = new Set<string>();
  const previews = props.presets.map((preset) => {
    const resolved = resolveSnoozePreset(preset, now, formatTime);
    if (resolved === null) return { tone: "muted", text: "Passed for today" } as const;
    if (seenIds.has(resolved.id)) {
      return { tone: "muted", text: "Duplicate of an option above" } as const;
    }
    if (seenWakes.has(resolved.snoozedUntil)) {
      return { tone: "muted", text: "Same time as an option above" } as const;
    }
    seenIds.add(resolved.id);
    seenWakes.add(resolved.snoozedUntil);
    return { tone: "menu", label: resolved.label, when: resolved.whenLabel } as const;
  });

  const menuPresets = resolveSnoozePresets(now, { presets: props.presets, formatTime });
  const repeatedLabels = new Set(
    menuPresets
      .map((preset) => preset.label)
      .filter((label, index, labels) => labels.indexOf(label) !== index),
  );
  const menuOrder = menuPresets.map((preset) =>
    repeatedLabels.has(preset.label) ? `${preset.label} ${preset.whenLabel}` : preset.label,
  );

  return (
    <div className="flex flex-col gap-1.5 pt-3 pb-2">
      {props.presets.map((preset, index) => {
        const preview = previews[index]!;
        return (
          <div
            key={props.keys[index]}
            role="group"
            aria-label={`Snooze option ${index + 1}`}
            className="flex flex-wrap items-center gap-2"
          >
            <SnoozePresetFields preset={preset} onChange={(next) => props.onChange(index, next)} />
            <div className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {preview.tone === "menu" ? (
                <span className="truncate">
                  <span className="text-foreground">{preview.label}</span>
                  <span className="ps-2 tabular-nums">{preview.when}</span>
                </span>
              ) : (
                <span className="truncate">{preview.text}</span>
              )}
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={`Remove snooze option ${index + 1}`}
                onClick={() => props.onRemove(index)}
              >
                <XIcon />
              </Button>
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        {menuOrder.length === 0 ? "Menus offer only Custom…" : `Menu now: ${menuOrder.join(" · ")}`}
      </p>
      <div>
        <Button
          variant="ghost-muted"
          size="compact"
          disabled={props.presets.length >= MAX_SNOOZE_PRESETS}
          onClick={props.onAdd}
        >
          <PlusIcon />
          Add option
        </Button>
        {props.presets.length >= MAX_SNOOZE_PRESETS ? (
          <span className="ps-2 text-xs text-muted-foreground">
            Up to {MAX_SNOOZE_PRESETS} options
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SnoozePresetFields(props: {
  preset: SnoozePresetSetting;
  onChange: (preset: SnoozePresetSetting) => void;
}) {
  const { preset, onChange } = props;
  const when = preset.kind === "after" ? "after" : preset.day;
  // Switching between a duration and a set time keeps the other kind's last value, so a
  // misclick on "When" can be undone without retyping it.
  const [memory, setMemory] = useState<KindMemory>({ minutes: 60, time: "09:00" });
  return (
    <div className="flex items-center gap-2">
      <Select
        value={when}
        items={WHEN_LABELS}
        onValueChange={(value) => {
          const next = value === null ? null : withWhen(preset, value, memory);
          if (!next) return;
          if (next.kind !== preset.kind) {
            setMemory(
              preset.kind === "after"
                ? { ...memory, minutes: preset.minutes }
                : { ...memory, time: preset.time },
            );
          }
          onChange(next);
        }}
      >
        <SelectTrigger size="sm" className="w-32" aria-label="When">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {WHEN_VALUES.map((value) => (
            <SelectItem hideIndicator key={value} value={value}>
              {WHEN_LABELS[value]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {preset.kind === "after" ? (
        <DurationFields
          minutes={preset.minutes}
          onChange={(minutes) => onChange({ ...preset, minutes })}
        />
      ) : (
        <>
          <span className="text-xs text-muted-foreground">at</span>
          <Input
            nativeInput
            size="sm"
            type="time"
            className="w-32"
            aria-label="Time"
            value={preset.time}
            onChange={(event) => {
              if (/^\d{2}:\d{2}$/.test(event.target.value)) {
                onChange({ ...preset, time: event.target.value });
              }
            }}
          />
        </>
      )}
    </div>
  );
}

function DurationFields(props: { minutes: number; onChange: (minutes: number) => void }) {
  // The chosen unit stays put while stepping, so 59 → 60 minutes does not jump to hours.
  const [chosenUnit, setChosenUnit] = useState(() => splitMinutes(props.minutes).unit);
  const unit =
    props.minutes % UNIT_MINUTES[chosenUnit] === 0 ? chosenUnit : splitMinutes(props.minutes).unit;
  const amount = props.minutes / UNIT_MINUTES[unit];
  const maxAmount = Math.floor(MAX_SNOOZE_PRESET_MINUTES / UNIT_MINUTES[unit]);
  // Typing stays local until the field commits (blur, Enter, or a step), so half-typed
  // values never reach the server.
  const [draft, setDraft] = useState<number | null>(amount);
  const [draftSource, setDraftSource] = useState(`${props.minutes}:${unit}`);
  if (draftSource !== `${props.minutes}:${unit}`) {
    setDraftSource(`${props.minutes}:${unit}`);
    setDraft(amount);
  }
  return (
    <>
      <NumberField
        size="sm"
        className="w-24"
        min={1}
        max={maxAmount}
        step={1}
        value={draft}
        onValueChange={setDraft}
        onValueCommitted={(value) => {
          if (value === null) {
            setDraft(amount);
            return;
          }
          const next = Math.min(maxAmount, Math.max(1, Math.round(value)));
          setDraft(next);
          if (next !== amount) props.onChange(next * UNIT_MINUTES[unit]);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label="Decrease" />
          <NumberFieldInput
            aria-label="Amount"
            // Base UI commits on blur but not on Enter; refocus so keyboard users stay put.
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const input = event.currentTarget;
              input.blur();
              input.focus();
            }}
          />
          <NumberFieldIncrement aria-label="Increase" />
        </NumberFieldGroup>
      </NumberField>
      <Select
        value={unit}
        items={amount === 1 ? SINGULAR_UNIT_LABELS : UNIT_LABELS}
        onValueChange={(value) => {
          if (value === "minutes" || value === "hours" || value === "days") {
            setChosenUnit(value);
            props.onChange(Math.min(amount * UNIT_MINUTES[value], MAX_SNOOZE_PRESET_MINUTES));
          }
        }}
      >
        <SelectTrigger size="sm" className="w-28" aria-label="Unit">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {(Object.keys(UNIT_LABELS) as DurationUnit[]).map((value) => (
            <SelectItem hideIndicator key={value} value={value}>
              {(amount === 1 ? SINGULAR_UNIT_LABELS : UNIT_LABELS)[value]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </>
  );
}
