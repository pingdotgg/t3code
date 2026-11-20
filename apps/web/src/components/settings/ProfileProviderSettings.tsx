import type {
  ClaudeProviderSettings,
  CodexProviderSettings,
  PiProviderSettings,
  ProfileProviderSettingsDriver,
  ProviderSettingsFile,
  ProviderSettingsOptions,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  booleanOfTriState,
  formatJsonObject,
  type JsonObject,
  parseJsonObject,
  PROFILE_DRIVER_LABELS,
  PROFILE_DRIVERS,
  profileNameError,
  type SettingsOption,
  settingsOptions,
  toggleInOptionalList,
  type TriState,
  triStateOf,
  uniqueName,
  withFeature,
  withKey,
} from "@t3tools/client-runtime/profiles-editor";

type Entry = ClaudeProviderSettings | CodexProviderSettings | PiProviderSettings;

const TRI_STATE_LABELS: Record<TriState, string> = {
  default: msg("Default", { $context: "setting state, follows the provider default" }),
  on: msg("On", { $context: "setting state" }),
  off: msg("Off", { $context: "setting state" }),
};

export interface ProviderSettingsEditorProps {
  readonly value: ProviderSettingsFile;
  readonly options: ProviderSettingsOptions | null;
  readonly optionsError: string | null;
  readonly optionsPending: boolean;
  readonly onRefreshOptions: () => void;
  /** Absent without permission to manage providers. */
  readonly onClearClaudeList: (() => void) | undefined;
  readonly disabled: boolean;
  /** Unsaved edits here; renames and deletes rewrite profiles and so need a clean section. */
  readonly dirty: boolean;
  readonly onChange: (next: ProviderSettingsFile) => void;
  readonly onRename: (
    driver: ProfileProviderSettingsDriver,
    from: string,
    to: string | null,
  ) => void;
  readonly usedBy: (driver: ProfileProviderSettingsDriver, name: string) => string[];
  /** Bumped when the draft is discarded or saved, so text fields reread the saved value. */
  readonly resetKey: number;
  readonly onJsonValidity: (key: string, valid: boolean) => void;
}

export function ProviderSettingsEditor(props: ProviderSettingsEditorProps) {
  const gt = useGT();
  const messages = useMessages();
  const [driver, setDriver] = useState<ProfileProviderSettingsDriver>("claudeAgent");
  const entries = props.value[driver] ?? {};
  const names = Object.keys(entries);
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected !== null && selected in entries ? selected : (names[0] ?? null);
  const [newName, setNewName] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const newNameError = newName === "" ? null : profileNameError(newName, names, messages);
  const renameError =
    renameTo === "" || renameTo === current ? null : profileNameError(renameTo, names, messages);

  const selectEntry = (name: string | null) => {
    if (current !== null) props.onJsonValidity(`${driver}:${current}`, true);
    setSelected(name);
    setRenameTo("");
  };

  const setEntries = (next: Readonly<Record<string, Entry>>) =>
    props.onChange(withKey(props.value, driver, Object.keys(next).length === 0 ? undefined : next));
  const setEntry = (name: string, entry: Entry) => setEntries({ ...entries, [name]: entry });

  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          aria-label={gt("Provider")}
          value={[driver]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "claudeAgent" || value === "codex" || value === "pi") {
              selectEntry(null);
              setDriver(value);
            }
          }}
        >
          {PROFILE_DRIVERS.map((id) => (
            <Toggle key={id} value={id}>
              {PROFILE_DRIVER_LABELS[id]}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          size="xs"
          variant="outline"
          disabled={props.optionsPending}
          onClick={props.onRefreshOptions}
        >
          {props.optionsPending ? gt("Detecting…") : gt("Detect options again")}
        </Button>
        {driver === "claudeAgent" && props.onClearClaudeList ? (
          <Button
            size="xs"
            variant="outline"
            disabled={props.optionsPending}
            onClick={props.onClearClaudeList}
          >
            <T>Clear list</T>
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        <T>
          Options come from what this machine’s <Var>{PROFILE_DRIVER_LABELS[driver]}</Var> reports.
          Muse and other providers have no provider settings.
        </T>
        {driver === "claudeAgent" ? (
          <>
            {" "}
            <T>
              Claude’s list keeps everything its threads have reported. Clear it after you uninstall
              something; the next Claude thread fills it again.
            </T>
          </>
        ) : null}
      </p>
      {props.optionsError ? (
        <p role="alert" className="text-xs text-destructive">
          {props.optionsError}
        </p>
      ) : null}
      {props.options?.[driver]?.error ? (
        <p role="status" className="text-xs text-warning">
          {props.options[driver]?.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {names.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            <T>
              No named <Var>{PROFILE_DRIVER_LABELS[driver]}</Var> settings. Profiles use the
              provider default.
            </T>
          </p>
        ) : (
          <Select
            value={current ?? ""}
            onValueChange={(value) => {
              selectEntry(value);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={gt("{provider} settings", { provider: PROFILE_DRIVER_LABELS[driver] })}
            >
              <SelectValue>{current}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {names.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Input
          aria-label={gt("New settings name")}
          placeholder={gt("New settings name")}
          value={newName}
          disabled={props.disabled}
          aria-invalid={newNameError !== null}
          onChange={(event) => setNewName(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || newName === "" || newNameError !== null}
          onClick={() => {
            setEntry(newName, {});
            selectEntry(newName);
            setNewName("");
          }}
        >
          <T>Add</T>
        </Button>
        {current !== null ? (
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            onClick={() => {
              const copy = uniqueName(`${current}-copy`, names);
              setEntry(copy, entries[current] ?? {});
              selectEntry(copy);
            }}
          >
            <T>Duplicate</T>
          </Button>
        ) : null}
      </div>
      {newNameError ? <p className="text-xs text-destructive">{newNameError}</p> : null}

      {current !== null ? (
        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={gt("Rename settings")}
              placeholder={current}
              value={renameTo}
              disabled={props.disabled || props.dirty}
              aria-invalid={renameError !== null}
              onChange={(event) => setRenameTo(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={
                props.disabled ||
                props.dirty ||
                renameTo === "" ||
                renameTo === current ||
                renameError !== null
              }
              onClick={() => {
                props.onRename(driver, current, renameTo);
                selectEntry(renameTo);
              }}
            >
              <T>Rename</T>
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={props.disabled || props.dirty}
              onClick={() => props.onRename(driver, current, null)}
            >
              <T>Delete</T>
            </Button>
          </div>
          {renameError ? <p className="text-xs text-destructive">{renameError}</p> : null}
          {props.dirty ? (
            <p className="text-xs text-muted-foreground">
              <T>
                Save or discard edits before renaming or deleting; profiles that use these settings
                change with them.
              </T>
            </p>
          ) : null}
          {props.usedBy(driver, current).length > 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>
                Used by <Var>{props.usedBy(driver, current).join(", ")}</Var>.
              </T>
            </p>
          ) : null}
          <DescriptionField
            value={entries[current]?.description}
            disabled={props.disabled}
            onChange={(description) =>
              setEntry(current, withKey(entries[current] ?? {}, "description", description))
            }
          />
          {driver === "claudeAgent" ? (
            <ClaudeForm
              key={`${current}:${props.resetKey}`}
              entry={props.value.claudeAgent?.[current] ?? {}}
              options={props.options?.claudeAgent}
              disabled={props.disabled}
              onChange={(entry) => setEntry(current, entry)}
              onJsonValidity={(valid) => props.onJsonValidity(`claudeAgent:${current}`, valid)}
            />
          ) : driver === "codex" ? (
            <CodexForm
              key={`${current}:${props.resetKey}`}
              entry={props.value.codex?.[current] ?? {}}
              options={props.options?.codex}
              disabled={props.disabled}
              onChange={(entry) => setEntry(current, entry)}
              onJsonValidity={(valid) => props.onJsonValidity(`codex:${current}`, valid)}
            />
          ) : (
            <PiForm
              entry={props.value.pi?.[current] ?? {}}
              disabled={props.disabled}
              onChange={(entry) => setEntry(current, entry)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function DescriptionField(props: {
  value: string | undefined;
  disabled: boolean;
  onChange: (value: string | undefined) => void;
}) {
  const gt = useGT();
  return (
    <Input
      aria-label={gt("Description")}
      placeholder={gt("Description")}
      value={props.value ?? ""}
      disabled={props.disabled}
      onChange={(event) =>
        props.onChange(event.target.value.trim() === "" ? undefined : event.target.value)
      }
    />
  );
}

function FieldRow(props: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{props.title}</p>
        {props.description ? (
          <p className="text-xs text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{props.children}</div>
    </div>
  );
}

/** A switch for an optional boolean: `fallback` is what leaving it out means. */
function OptionalSwitch(props: {
  title: string;
  description?: string;
  value: boolean | undefined;
  fallback: boolean;
  disabled: boolean;
  onChange: (value: boolean | undefined) => void;
}) {
  return (
    <FieldRow
      title={props.title}
      {...(props.description ? { description: props.description } : {})}
    >
      <Switch
        aria-label={props.title}
        checked={props.value ?? props.fallback}
        disabled={props.disabled}
        onCheckedChange={(checked) =>
          props.onChange(Boolean(checked) === props.fallback ? undefined : Boolean(checked))
        }
      />
    </FieldRow>
  );
}

function TriStateSelect(props: {
  label: string;
  value: TriState;
  disabled: boolean;
  onChange: (value: TriState) => void;
}) {
  const m = useMessages();
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value === "default" || value === "on" || value === "off") props.onChange(value);
      }}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue>{m(TRI_STATE_LABELS[props.value])}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {(["default", "on", "off"] as const).map((state) => (
          <SelectItem key={state} value={state}>
            {m(TRI_STATE_LABELS[state])}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Checked names are the ones listed, such as blocked tools or turned-off skills. */
function NameChecklist(props: {
  title: string;
  description: string;
  options: ReadonlyArray<SettingsOption>;
  checked: ReadonlyArray<string> | undefined;
  disabled: boolean;
  onChange: (next: ReadonlyArray<string> | undefined) => void;
}) {
  const checked = new Set(props.checked ?? []);
  return (
    <div className="space-y-1.5">
      <div>
        <p className="text-sm text-foreground">{props.title}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>Nothing reported on this machine.</T>
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {props.options.map((option) => (
            <label key={option.name} className="flex min-w-0 items-center gap-2 text-xs">
              <Checkbox
                checked={checked.has(option.name)}
                disabled={props.disabled}
                onCheckedChange={(on) =>
                  props.onChange(toggleInOptionalList(props.checked, option.name, on === true))
                }
              />
              <span className="truncate">{option.name}</span>
              {option.detected ? null : (
                <Badge variant="outline" size="sm">
                  <T>not on this machine</T>
                </Badge>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function JsonField(props: {
  title: string;
  description: string;
  value: JsonObject | undefined;
  disabled: boolean;
  onChange: (value: JsonObject | undefined) => void;
  onValidity: (valid: boolean) => void;
}) {
  const messages = useMessages();
  const [text, setText] = useState(() => formatJsonObject(props.value));
  const parsed = parseJsonObject(text, messages);
  return (
    <div className="space-y-1.5">
      <div>
        <p className="text-sm text-foreground">{props.title}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      <Textarea
        aria-label={props.title}
        value={text}
        disabled={props.disabled}
        aria-invalid={!parsed.ok}
        onChange={(event) => {
          const next = parseJsonObject(event.target.value, messages);
          setText(event.target.value);
          props.onValidity(next.ok);
          if (next.ok) props.onChange(next.value);
        }}
      />
      {parsed.ok ? null : <p className="text-xs text-destructive">{parsed.error}</p>}
    </div>
  );
}

function ClaudeForm(props: {
  entry: ClaudeProviderSettings;
  options: ProviderSettingsOptions["claudeAgent"];
  disabled: boolean;
  onChange: (entry: ClaudeProviderSettings) => void;
  onJsonValidity: (valid: boolean) => void;
}) {
  const gt = useGT();
  const { entry, disabled } = props;
  const set = <K extends keyof ClaudeProviderSettings>(
    key: K,
    value: ClaudeProviderSettings[K] | undefined,
  ) => props.onChange(withKey(entry, key, value));
  return (
    <div className="space-y-3">
      <NameChecklist
        title={gt("Blocked tools")}
        description={gt("Claude may not use these. T3’s own tools are never blocked.")}
        options={settingsOptions(
          props.options?.tools,
          entry.blockedTools ?? [],
          props.options?.error,
        )}
        checked={entry.blockedTools}
        disabled={disabled}
        onChange={(next) => set("blockedTools", next)}
      />
      <OptionalSwitch
        title={gt("Bundled skills")}
        description={gt("Skills that ship with Claude Code.")}
        value={entry.bundledSkills}
        fallback
        disabled={disabled}
        onChange={(value) => set("bundledSkills", value)}
      />
      <NameChecklist
        title={gt("Turned-off skills")}
        description={gt("Installed Claude skills left out of the session.")}
        options={settingsOptions(
          props.options?.skills,
          entry.disabledSkills ?? [],
          props.options?.error,
        )}
        checked={entry.disabledSkills}
        disabled={disabled}
        onChange={(next) => set("disabledSkills", next)}
      />
      <NameChecklist
        title={gt("Turned-off plugins")}
        description={gt("Installed Claude plugins left out of the session.")}
        options={settingsOptions(
          props.options?.plugins,
          entry.disabledPlugins ?? [],
          props.options?.error,
        )}
        checked={entry.disabledPlugins}
        disabled={disabled}
        onChange={(next) => set("disabledPlugins", next)}
      />
      <FieldRow title={gt("Auto memory")} description={gt("Default follows your Claude settings.")}>
        <TriStateSelect
          label={gt("Auto memory")}
          value={triStateOf(entry.autoMemory)}
          disabled={disabled}
          onChange={(state) => set("autoMemory", booleanOfTriState(state))}
        />
      </FieldRow>
      <OptionalSwitch
        title={gt("Co-author", { $context: "setting, commit attribution" })}
        description={gt("Claude’s attribution on commits and pull requests.")}
        value={entry.coAuthor}
        fallback
        disabled={disabled}
        onChange={(value) => set("coAuthor", value)}
      />
      <OptionalSwitch
        // oxlint-disable-next-line t3code/no-untranslated-copy -- Anthropic product name
        title="Claude in Chrome"
        value={entry.chrome}
        fallback={false}
        disabled={disabled}
        onChange={(value) => set("chrome", value)}
      />
      <JsonField
        title={gt("Advanced settings")}
        description={gt("Further Claude Code settings keys, as JSON. Keys T3 needs are ignored.")}
        value={entry.settings}
        disabled={disabled}
        onChange={(value) => set("settings", value)}
        onValidity={props.onJsonValidity}
      />
    </div>
  );
}

function CodexForm(props: {
  entry: CodexProviderSettings;
  options: ProviderSettingsOptions["codex"];
  disabled: boolean;
  onChange: (entry: CodexProviderSettings) => void;
  onJsonValidity: (valid: boolean) => void;
}) {
  const gt = useGT();
  const { entry, disabled } = props;
  const features = settingsOptions(
    props.options?.features,
    Object.keys(entry.features ?? {}),
    props.options?.error,
  );
  const unapplied = [...(entry.disabledSkills ?? []), ...(entry.disabledPlugins ?? [])];
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-sm text-foreground">
          <T>Features</T>
        </p>
        {features.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            <T>Nothing reported on this machine.</T>
          </p>
        ) : (
          <div className="space-y-1">
            {features.map((feature) => (
              <div key={feature.name} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-xs">
                  {feature.enabled === undefined
                    ? feature.name
                    : feature.enabled
                      ? gt("{name} (on by default)", { name: feature.name })
                      : gt("{name} (off by default)", { name: feature.name })}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {feature.detected ? null : (
                    <Badge variant="outline" size="sm">
                      <T>not on this machine</T>
                    </Badge>
                  )}
                  <TriStateSelect
                    label={feature.name}
                    value={triStateOf(entry.features?.[feature.name])}
                    disabled={disabled}
                    onChange={(state) =>
                      props.onChange(
                        withKey(
                          entry,
                          "features",
                          withFeature(entry.features, feature.name, state),
                        ),
                      )
                    }
                  />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {unapplied.length > 0 ? (
        <FieldRow
          title={gt("Turned-off skills and plugins")}
          description={gt(
            "{names}. Codex cannot turn these off for one thread yet, so T3 does not apply them.",
            { names: unapplied.join(", ") },
          )}
        >
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              props.onChange(
                withKey(withKey(entry, "disabledSkills", undefined), "disabledPlugins", undefined),
              )
            }
          >
            <T context="verb, removes the listed names">Clear</T>
          </Button>
        </FieldRow>
      ) : null}
      <JsonField
        title={gt("Advanced config")}
        description={gt("Further dotted config keys, as JSON. Keys T3 needs are refused.")}
        value={entry.config}
        disabled={disabled}
        onChange={(value) => props.onChange(withKey(entry, "config", value))}
        onValidity={props.onJsonValidity}
      />
    </div>
  );
}

function PiForm(props: {
  entry: PiProviderSettings;
  disabled: boolean;
  onChange: (entry: PiProviderSettings) => void;
}) {
  const gt = useGT();
  return (
    <div className="space-y-3">
      <OptionalSwitch
        title={gt("Pi skills")}
        description={gt("Off starts Pi without its own skills. Profile skills are still listed.")}
        value={props.entry.skills}
        fallback
        disabled={props.disabled}
        onChange={(value) => props.onChange(withKey(props.entry, "skills", value))}
      />
      <OptionalSwitch
        title={gt("Prompt templates")}
        value={props.entry.promptTemplates}
        fallback
        disabled={props.disabled}
        onChange={(value) => props.onChange(withKey(props.entry, "promptTemplates", value))}
      />
    </div>
  );
}
