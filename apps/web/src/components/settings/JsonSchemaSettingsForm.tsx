import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { XIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SecretInput } from "./SecretInput";
import { type PluginSettingsField, pluginSettingsForm } from "./plugins/pluginSettingsForm";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

// `null` clears a saved value, so the plugin gets its default again.
type DraftValue = string | boolean | null;
export type Draft = Readonly<Record<string, DraftValue>>;

const draftValue = (field: PluginSettingsField, value: Schema.Json | undefined) => {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean" ? value : (field.defaultValue ?? false);
    case "secret":
      return "";
    case "list":
      return Array.isArray(value) ? value.join("\n") : "";
    default:
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
};

/** The changed fields as a settings patch, or the first problem a user can fix before saving. */
export const toPatch = (
  fields: ReadonlyArray<PluginSettingsField>,
  saved: Draft,
  draft: Draft,
): { readonly patch: Schema.JsonObject } | { readonly problem: string } => {
  const patch: Record<string, Schema.Json> = {};
  for (const field of fields) {
    const value = draft[field.key];
    if (value === saved[field.key] || value === undefined) continue;
    if (value === null) {
      patch[field.key] = null;
    } else if (typeof value === "boolean") {
      patch[field.key] = value;
    } else if (field.kind === "secret") {
      if (value !== "") patch[field.key] = value;
    } else if (value.trim() === "") {
      patch[field.key] = null;
    } else if (field.kind === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || (field.integer && !Number.isInteger(parsed))) {
        return {
          problem: `${field.label} must be ${field.integer ? "a whole number" : "a number"}.`,
        };
      }
      if (field.minimum !== undefined && parsed < field.minimum) {
        return { problem: `${field.label} must be at least ${field.minimum}.` };
      }
      if (field.maximum !== undefined && parsed > field.maximum) {
        return { problem: `${field.label} must be at most ${field.maximum}.` };
      }
      patch[field.key] = parsed;
    } else if (field.kind === "select") {
      patch[field.key] = field.options.find((option) => String(option) === value) ?? value;
    } else if (field.kind === "list") {
      patch[field.key] = value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } else {
      patch[field.key] = value;
    }
  }
  return { patch };
};

const parseJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

/** The edited JSON as a settings patch, with `null` for each saved key it no longer has. */
export const toJsonPatch = (
  saved: Schema.JsonObject,
  json: string,
): { readonly patch: Schema.JsonObject } | { readonly problem: string } => {
  const parsed = parseJsonObject(json);
  if (Option.isNone(parsed)) return { problem: "Settings must be a JSON object." };
  const removed = Object.keys(saved).filter((key) => !Object.hasOwn(parsed.value, key));
  return { patch: { ...Object.fromEntries(removed.map((key) => [key, null])), ...parsed.value } };
};

const without = <Value,>(record: Readonly<Record<string, Value>>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));

/**
 * Settings rows drawn from a plugin's JSON Schema. Each field saves on its own, as T3's own
 * settings rows do. `onSave` gets that field as a patch, `null` when cleared, and resolves with the
 * settings as saved or the reason they were not.
 */
export function JsonSchemaSettingsForm({
  idPrefix,
  label,
  schema,
  settings,
  canSave,
  onSave,
}: {
  readonly idPrefix: string;
  readonly label: string;
  readonly schema: Schema.JsonObject | undefined;
  readonly settings: Schema.JsonObject;
  readonly canSave: boolean;
  readonly onSave: (
    patch: Schema.JsonObject,
  ) => Promise<{ readonly settings: Schema.JsonObject } | { readonly problem: string }>;
}) {
  const form = pluginSettingsForm(schema);
  const [saved, setSaved] = useState(settings);
  // What the user just set, shown until it saves; it stays, with its problem, when it can't.
  const [pending, setPending] = useState<Readonly<Record<string, DraftValue>>>({});
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const settle = (key: string, problem: string | null) => {
    setProblems((all) => (problem === null ? without(all, key) : { ...all, [key]: problem }));
    if (problem === null) setPending((all) => without(all, key));
  };

  if (form.kind === "json") {
    return (
      <JsonSettingsRow
        label={label}
        settings={saved}
        canSave={canSave}
        onSave={onSave}
        onSaved={setSaved}
      />
    );
  }
  if (form.kind !== "fields") return null;

  const commit = async (field: PluginSettingsField, value: DraftValue) => {
    const current = draftValue(field, saved[field.key]);
    const next = toPatch([field], { [field.key]: current }, { [field.key]: value });
    setPending((all) => ({ ...all, [field.key]: value }));
    if ("problem" in next) return settle(field.key, next.problem);
    if (Object.keys(next.patch).length === 0) return settle(field.key, null);
    const result = await onSave(next.patch);
    if ("problem" in result) return settle(field.key, result.problem);
    setSaved(result.settings);
    settle(field.key, null);
  };

  return (
    <>
      {form.fields.map((field) => (
        <JsonSchemaFieldRow
          key={field.key}
          id={`${idPrefix}-${field.key}`}
          field={field}
          value={
            Object.hasOwn(pending, field.key)
              ? pending[field.key]
              : draftValue(field, saved[field.key])
          }
          isSet={saved[field.key] !== undefined}
          canReset={
            saved[field.key] !== undefined &&
            draftValue(field, saved[field.key]) !== draftValue(field, undefined)
          }
          problem={problems[field.key]}
          disabled={!canSave}
          onCommit={(value) => void commit(field, value)}
        />
      ))}
    </>
  );
}

/** For settings whose schema doesn't fit a form: the settings as JSON, saved together. */
function JsonSettingsRow({
  label,
  settings,
  canSave,
  onSave,
  onSaved,
}: {
  readonly label: string;
  readonly settings: Schema.JsonObject;
  readonly canSave: boolean;
  readonly onSave: (
    patch: Schema.JsonObject,
  ) => Promise<{ readonly settings: Schema.JsonObject } | { readonly problem: string }>;
  readonly onSaved: (settings: Schema.JsonObject) => void;
}) {
  const [json, setJson] = useState(() => JSON.stringify(settings, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const next = toJsonPatch(settings, json);
    if ("problem" in next) return setProblem(next.problem);
    setBusy(true);
    const result = await onSave(next.patch);
    setBusy(false);
    if ("problem" in result) return setProblem(result.problem);
    setProblem(null);
    onSaved(result.settings);
    setJson(JSON.stringify(result.settings, null, 2));
  };
  return (
    <SettingsRow
      title="Settings as JSON"
      description="These settings don't fit a form."
      status={problem ? <span className="text-destructive">{problem}</span> : undefined}
    >
      <div className="space-y-2 pb-2">
        <Textarea
          aria-label={`${label} settings JSON`}
          rows={8}
          value={json}
          onChange={(event) => setJson(event.target.value)}
        />
        <div className="flex justify-end">
          <Button size="sm" disabled={busy || !canSave} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}

const UNSET_OPTION = "\u0000unset";
const FIELD_WIDTH = "w-full max-w-full @min-[32rem]/settings-row:w-56";

function JsonSchemaFieldRow({
  id,
  field,
  value,
  isSet,
  canReset,
  problem,
  disabled,
  onCommit,
}: {
  readonly id: string;
  readonly field: PluginSettingsField;
  readonly value: DraftValue | undefined;
  /** The settings have a value for this field, so a secret can be cleared. */
  readonly isSet: boolean;
  /** The saved value differs from what the plugin gets with none. */
  readonly canReset: boolean;
  readonly problem: string | undefined;
  readonly disabled: boolean;
  readonly onCommit: (value: DraftValue) => void;
}) {
  const text = typeof value === "string" ? value : "";
  const descriptionId = field.description ? `${id}-description` : undefined;
  // What the plugin gets while the field is empty.
  const fallback =
    field.kind === "secret" || field.kind === "boolean" || field.defaultValue === undefined
      ? undefined
      : field.kind === "list"
        ? field.defaultValue.join(", ")
        : String(field.defaultValue);
  const title = `${field.label}${field.required ? " *" : ""}`;
  const control =
    field.kind === "boolean" ? (
      <Switch
        checked={value === true}
        disabled={disabled}
        aria-label={field.label}
        aria-describedby={descriptionId}
        onCheckedChange={(checked) => onCommit(checked)}
      />
    ) : field.kind === "select" ? (
      <Select
        value={text === "" ? UNSET_OPTION : text}
        disabled={disabled}
        onValueChange={(next) =>
          typeof next === "string" && onCommit(next === UNSET_OPTION ? "" : next)
        }
      >
        <SelectTrigger id={id} size="sm" className={FIELD_WIDTH} aria-label={field.label}>
          <SelectValue>
            {text || (fallback === undefined ? "" : `${fallback} (default)`)}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {/* Back to the default, as clearing a text field is. */}
          {fallback !== undefined || !field.required ? (
            <SelectItem value={UNSET_OPTION}>
              {fallback === undefined ? "Not set" : `${fallback} (default)`}
            </SelectItem>
          ) : null}
          {field.options.map((option) => (
            <SelectItem key={String(option)} value={String(option)}>
              {String(option)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : field.kind === "list" ? (
      <DraftTextarea
        id={id}
        rows={3}
        disabled={disabled}
        aria-describedby={descriptionId}
        className="w-full max-w-full @min-[32rem]/settings-row:w-[min(24rem,50cqw)]"
        placeholder={
          fallback === undefined ? "One value per line" : `One value per line. Default: ${fallback}`
        }
        value={text}
        onCommit={onCommit}
      />
    ) : field.kind === "secret" ? (
      <div className={`flex min-w-0 items-center gap-2 ${FIELD_WIDTH}`}>
        <SecretInput
          id={id}
          size="sm"
          disabled={disabled}
          aria-describedby={descriptionId}
          className="min-w-0 flex-1"
          configured={isSet}
          value=""
          onCommit={onCommit}
        />
        {isSet ? (
          <Button
            size="icon-sm"
            variant="ghost-destructive"
            disabled={disabled}
            aria-label={`Clear ${field.label}`}
            onClick={() => onCommit(null)}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    ) : (
      <DraftInput
        id={id}
        size="sm"
        disabled={disabled}
        aria-describedby={descriptionId}
        className={FIELD_WIDTH}
        // Text, not a number input, so text that isn't a number stays to be fixed instead of
        // reading as empty, which would clear the saved value.
        type="text"
        inputMode={field.kind === "number" ? (field.integer ? "numeric" : "decimal") : undefined}
        maxLength={field.kind === "text" ? field.maxLength : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={fallback === undefined ? undefined : `Default: ${fallback}`}
        value={text}
        onCommit={onCommit}
      />
    );
  return (
    <SettingsRow
      title={field.kind === "boolean" ? title : <label htmlFor={id}>{title}</label>}
      description={
        field.description ? <span id={descriptionId}>{field.description}</span> : undefined
      }
      status={problem ? <span className="text-destructive">{problem}</span> : undefined}
      resetAction={
        canReset && field.kind !== "secret" && !disabled ? (
          <SettingResetButton label={field.label} onClick={() => onCommit(null)} />
        ) : null
      }
      control={control}
    />
  );
}

/** A textarea that saves when it loses focus, as `DraftInput` does for one line. */
function DraftTextarea({
  value,
  onCommit,
  ...rest
}: Omit<ComponentProps<typeof Textarea>, "value" | "onChange" | "onBlur"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      {...rest}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
    />
  );
}
