import { useAtomValue } from "@effect/atom-react";
import {
  type PluginSettingDraft,
  type PluginSettingDrafts,
  pluginSettingDraftsAfterSave,
  pluginSettingForm,
  pluginSettingRows,
} from "@t3tools/client-runtime/state/pluginSettings";
import {
  type EnvironmentId,
  PLUGIN_SETTING_SECRET_MAX_LENGTH,
  PLUGIN_SETTING_TEXT_MAX_LENGTH,
  type PluginInstallation,
  type PluginSettingChange,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { pluginSettingsEnvironment } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

import styles from "./PluginSettingsForm.module.css";

// Secrets remain write-only; read-only sessions cannot save settings to the environment.
export function PluginSettingsForm({
  environmentId,
  installation,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly readOnly?: boolean;
}) {
  const fields = installation.manifest?.settings ?? [];
  const installationId = installation.installationId;
  const result = useAtomValue(
    pluginSettingsEnvironment.values({ environmentId, input: { installationId } }),
  );
  const update = useAtomCommand(pluginSettingsEnvironment.update, {
    label: `save ${installation.manifest?.name ?? "plugin"} settings`,
  });
  const [drafts, setDrafts] = useState<PluginSettingDrafts>(() => new Map());
  const [saving, setSaving] = useState(false);
  const view = Option.getOrNull(AsyncResult.value(result));
  if (fields.length === 0 || view === null || view._tag === "unsupported") return null;

  const { entries, changes, invalid } = pluginSettingForm(
    pluginSettingRows(fields, view.values),
    drafts,
  );
  const setDraft = (key: string, draft: PluginSettingDraft) =>
    setDrafts((current) => new Map(current).set(key, draft));

  const save = async (next: ReadonlyArray<PluginSettingChange>, clearDrafts: boolean) => {
    // Disabled controls are the affordance; this keeps a read-only form from saving by any path.
    if (readOnly || saving) return;
    setSaving(true);
    return update({ environmentId, input: { installationId, changes: next } })
      .then((saved) => {
        if (saved._tag === "Success")
          setDrafts((current) =>
            clearDrafts ? new Map() : pluginSettingDraftsAfterSave(current, next),
          );
      })
      .finally(() => setSaving(false));
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (changes.length > 0 && !invalid) void save(changes, true);
      }}
    >
      {/* Locked while saving: a successful save clears the drafts it sent. */}
      <fieldset disabled={saving || readOnly} className="contents">
        {entries.map(({ row, draft, outcome }) => {
          const { field } = row;
          const id = `plugin-setting-${installationId}-${field.key}`;
          const reset = () => void save([{ key: field.key, value: null }], false);
          return (
            <div key={field.key} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={id}>{field.label}</Label>
                {field.type === "boolean" ? (
                  <Switch
                    id={id}
                    checked={draft === true}
                    onCheckedChange={(checked) => setDraft(field.key, checked)}
                  />
                ) : null}
              </div>
              {field.type === "select" ? (
                <Select
                  value={draft === "" ? null : String(draft)}
                  onValueChange={(value) => {
                    if (typeof value === "string") setDraft(field.key, value);
                  }}
                >
                  <SelectTrigger id={id} size="sm" aria-label={field.label}>
                    <SelectValue>
                      {field.options.find((option) => option.value === draft)?.label ??
                        "Choose an option"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {field.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : field.type === "boolean" ? null : field.type === "number" ? (
                <Input
                  id={id}
                  size="sm"
                  autoComplete="off"
                  inputMode="decimal"
                  value={String(draft)}
                  onChange={(event) => setDraft(field.key, event.target.value)}
                />
              ) : (
                <div className={field.type === "secret" ? styles.secret : undefined}>
                  <Textarea
                    id={id}
                    size="sm"
                    autoComplete="off"
                    spellCheck={field.type !== "secret"}
                    maxLength={
                      field.type === "secret"
                        ? PLUGIN_SETTING_SECRET_MAX_LENGTH
                        : PLUGIN_SETTING_TEXT_MAX_LENGTH
                    }
                    placeholder={
                      field.type === "secret"
                        ? row.saved
                          ? "Saved. Enter a new value to replace it."
                          : "Not set"
                        : undefined
                    }
                    value={String(draft)}
                    onChange={(event) => setDraft(field.key, event.target.value)}
                  />
                </div>
              )}
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {outcome?._tag === "invalid" ? (
                    <span className="text-destructive">{outcome.message}</span>
                  ) : (
                    (field.description ?? null)
                  )}
                </p>
                {row.saved ? (
                  <Button size="xs" variant="ghost" onClick={reset}>
                    {field.type === "secret" ? "Clear" : "Reset"}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
        <div className="flex justify-end">
          <Button type="submit" size="xs" disabled={changes.length === 0 || invalid}>
            Save
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
